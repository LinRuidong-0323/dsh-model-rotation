/**
 * Offline assertions for model rotation.
 *
 * These run without DSH and without a network. They cover the semantics that
 * silently break: commit rules, failover classification, capability gating,
 * cleanup on abort, and the request body surviving the hop.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildChain,
  nextRoute,
  normalizeRoute,
  shouldFailover,
  MAX_NOTE_LENGTH,
  RETRYABLE_CODES,
  TERMINAL_CODES,
} from '../src/chain.js'
import { normalizeSettings, normalizeChain, SettingsStore, ROUTER_PROVIDER } from '../src/config.js'
import {
  carriesProgress,
  classifyUnfinishedStream,
  codeOf,
  commitsAttempt,
  runAttempt,
} from '../src/attempt.js'
import { estimateRequestTokens, requestHasImage, requirementsOf, routeCanServe } from '../src/capability.js'
import { RotationAdapter, summarizeFailure } from '../src/adapter.js'
import { RequestLog } from '../src/request-log.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build a stream from a list of chunks, optionally throwing after them. */
async function* streamOf(chunks, throwAfter) {
  for (const chunk of chunks) yield chunk
  if (throwAfter !== undefined) throw throwAfter
}

/** A stream that records whether it was closed. */
function trackedStream(chunks, { hang = false } = {}) {
  const state = { closed: false, pulled: 0 }
  const iterable = {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          if (hang) return new Promise(() => {}) // never resolves
          state.pulled += 1
          if (index >= chunks.length) return { done: true, value: undefined }
          return { done: false, value: chunks[index++] }
        },
        async return() {
          state.closed = true
          return { done: true, value: undefined }
        },
      }
    },
  }
  return { iterable, state }
}

/** Drain an attempt, returning the chunks and its outcome. */
async function drain(attempt) {
  const chunks = []
  for await (const chunk of attempt.chunks) chunks.push(chunk)
  return { chunks, outcome: await attempt.outcome }
}

/** Build an adapter over an in-memory settings document. */
function adapterWith(chains, llm, hooks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-adapter-'))
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  store.write({ chains })
  const adapter = new RotationAdapter({ store, hooks })
  adapter.ctx = { llm }
  return { adapter, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/**
 * A fake `ctx.llm` mirroring the registry contract that matters here:
 * `prepareCall(config)` returns a handle whose `stream(options)` rejects options
 * that differ from the resolved control fields.
 */
function fakeLlm(routes, options = {}) {
  const calls = []
  return {
    calls,
    async prepareCall(config) {
      const provider = config.provider
      const model = config.model
      const key = provider + '/' + model
      calls.push({ key, config })
      const spec = routes[key]
      if (spec === undefined) {
        const error = Object.assign(new Error('no such route ' + key), { code: 'NO_ADAPTER' })
        throw error
      }
      const resolved = {
        provider,
        model,
        reasoningEffort: config.reasoningEffort,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        stop: config.stop,
      }
      return {
        config: resolved,
        model: { provider, id: model, name: model },
        stream(forwarded) {
          const differs = ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop'].filter(
            field => forwarded[field] !== resolved[field],
          )
          if (differs.length > 0) {
            throw Object.assign(
              new Error('prepared LLM call config changed before adapter dispatch: ' + differs.join(',')),
              { code: 'INVALID_PREPARED_CALL' },
            )
          }
          // Record what the route actually received: the tests assert on it.
          calls[calls.length - 1].forwarded = {
            messageCount: Array.isArray(forwarded.messages) ? forwarded.messages.length : null,
            messages: forwarded.messages ?? null,
            toolNames: Array.isArray(forwarded.tools) ? forwarded.tools.map(t => t.name) : null,
            hasSignal: forwarded.signal !== undefined,
            hasIdleTimeout: forwarded.idleTimeoutMs !== undefined,
            hasTimeout: forwarded.timeoutMs !== undefined,
            hasNote: forwarded.note !== undefined,
          }
          if (spec.stream !== undefined) return spec.stream(forwarded)
          return (async function* () {
            for (const chunk of spec.chunks ?? []) yield chunk
            if (spec.throw !== undefined) throw spec.throw
          })()
        },
      }
    },
    async resolveModelInfo(provider, model) {
      if (options.info !== undefined) return options.info(provider, model)
      return { context: { contextWindow: 128000 }, inputModalities: ['text'] }
    },
  }
}

// ---------------------------------------------------------------------------
// chain classification
// ---------------------------------------------------------------------------

test('retryable codes advance the chain, terminal codes do not', () => {
  for (const code of RETRYABLE_CODES) assert.equal(shouldFailover(code), true, code + ' should fail over')
  for (const code of TERMINAL_CODES) assert.equal(shouldFailover(code), false, code + ' must not fail over')
})

test('an unknown or missing code is treated as terminal', () => {
  assert.equal(shouldFailover(undefined), false)
  assert.equal(shouldFailover(''), false)
  assert.equal(shouldFailover('SOMETHING_NEW'), false)
})

test('a user abort never fails over', () => {
  assert.equal(shouldFailover('ABORTED'), false)
})

test('CONTEXT_WINDOW_EXCEEDED fails over to the next route', () => {
  // Providers disagree about what "too long" means, so a chain whose first route
  // rejects the length must still try the route behind it. Treating this as
  // terminal meant a 4-route chain reported "every route failed" after trying
  // exactly one.
  assert.equal(shouldFailover('CONTEXT_WINDOW_EXCEEDED'), true)
  assert.ok(RETRYABLE_CODES.includes('CONTEXT_WINDOW_EXCEEDED'))
  assert.ok(!TERMINAL_CODES.includes('CONTEXT_WINDOW_EXCEEDED'))
})

test('a context-window failure moves to the next model in the chain', async () => {
  // End-to-end version of the same rule: route 1 rejects the length, route 2
  // must be tried and its answer returned.
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } } }] },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'from-b' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)
  assert.equal(chunks[0].text, 'from-b', 'the second route must answer')
  assert.deepEqual(llm.calls.map(c => c.key), ['p1/a', 'p2/b'])
  cleanup()
})

test('an invalid prepared call advances the chain instead of ending it', () => {
  // The host binds a prepared call to one dispatch and rejects a dispatch whose
  // controls drifted. Both surface as INVALID_PREPARED_CALL, and both belong to
  // the handle rather than the conversation: the next route is prepared with a
  // fresh handle and can still answer.
  //
  // Leaving this code unclassified made it terminal by default, so one stale
  // handle ended the whole walk. In the recorded request log this code was 30 of
  // 40 failures, every one stopping at the first route.
  assert.equal(shouldFailover('INVALID_PREPARED_CALL'), true)
  assert.ok(RETRYABLE_CODES.includes('INVALID_PREPARED_CALL'))
  assert.ok(!TERMINAL_CODES.includes('INVALID_PREPARED_CALL'))
})

test('a dispatch-time prepared-call failure falls over to the next route', async () => {
  // End to end: route 1 throws at dispatch (synchronously, before any I/O), and
  // route 2 must still be tried and answer.
  const llm = fakeLlm({
    'p1/a': {
      stream() {
        throw Object.assign(new Error('a prepared LLM call can only be dispatched once'), {
          code: 'INVALID_PREPARED_CALL',
        })
      },
    },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'from-b' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)

  assert.equal(chunks[0].text, 'from-b', 'the second route must answer')
  assert.deepEqual(llm.calls.map(call => call.key), ['p1/a', 'p2/b'], 'both routes must be attempted')
  cleanup()
})

test('buildChain puts the requested route first and drops duplicates', () => {  const chain = buildChain(
    { provider: 'p1', model: 'm1' },
    [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
      { provider: 'p2', model: 'm2' },
      { provider: 'p3', model: 'm3' },
    ],
  )
  assert.deepEqual(chain, [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' },
    { provider: 'p3', model: 'm3' },
  ])
})

test('normalizeRoute rejects half a route', () => {
  assert.equal(normalizeRoute({ provider: 'p', model: '' }), undefined)
  assert.equal(normalizeRoute({ provider: '', model: 'm' }), undefined)
  assert.equal(normalizeRoute(null), undefined)
  assert.deepEqual(normalizeRoute({ provider: ' p ', model: ' m ' }), { provider: 'p', model: 'm' })
})

test('normalizeRoute keeps a note, trimmed and capped', () => {
  assert.deepEqual(normalizeRoute({ provider: 'p', model: 'm', note: ' 强推理 ' }), {
    provider: 'p',
    model: 'm',
    note: '强推理',
  })
  const long = normalizeRoute({ provider: 'p', model: 'm', note: 'x'.repeat(500) })
  assert.equal(long.note.length, MAX_NOTE_LENGTH, 'a note must be bounded')
})

test('a route without a note keeps the old two-field shape', () => {
  // An existing settings file must not be rewritten just because it was read:
  // the absence of a note has to stay an absent key, not an empty string.
  const route = normalizeRoute({ provider: 'p', model: 'm' })
  assert.equal('note' in route, false)
  assert.deepEqual(normalizeRoute({ provider: 'p', model: 'm', note: '   ' }), { provider: 'p', model: 'm' })
  assert.equal('note' in normalizeRoute({ provider: 'p', model: 'm', note: null }), false)
})

test('a note survives a settings round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-note-'))
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  store.write({
    chains: [{ id: 'a', routes: [{ provider: 'p', model: 'm', note: '便宜' }, { provider: 'q', model: 'n' }] }],
  })
  const { settings } = store.read()
  assert.equal(settings.chains[0].routes[0].note, '便宜')
  assert.equal('note' in settings.chains[0].routes[1], false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a note never reaches the downstream provider', async () => {
  // The note is a label for the user. Forwarding it would hand a provider a
  // field it never defined, and a prompt-shaped field could leak into the model.
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a', note: 'SECRET-LABEL' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  for await (const _chunk of prepared.stream({ messages: [] })) {
    // drain
  }
  const forwarded = llm.calls[0].forwarded
  assert.equal(forwarded.hasNote, false, 'the note must not be forwarded')
  assert.equal(JSON.stringify(llm.calls[0].forwarded).includes('SECRET-LABEL'), false)
  cleanup()
})

test('a note is shown in the picker description', async () => {
  const llm = fakeLlm({})
  const { adapter, cleanup } = adapterWith(
    [
      {
        id: 'main',
        name: '日常',
        routes: [
          { provider: 'p1', model: 'a', note: '便宜' },
          { provider: 'p2', model: 'b' },
        ],
      },
    ],
    llm,
  )
  const models = await adapter.listModels()
  assert.match(models[0].description, /p1\/a（便宜）/)
  assert.match(models[0].description, /p2\/b/)
  assert.doesNotMatch(models[0].description, /p2\/b（/, 'a route without a note gets no brackets')
  cleanup()
})

test('nextRoute walks forward and stops at the end', () => {
  const chain = [{ provider: 'a', model: '1' }, { provider: 'b', model: '2' }]
  assert.deepEqual(nextRoute(chain, 0), { provider: 'b', model: '2' })
  assert.equal(nextRoute(chain, 1), undefined)
})

test('codeOf reads a direct code, a failure envelope, and nothing else', () => {
  assert.equal(codeOf({ code: 'RATE_LIMIT' }), 'RATE_LIMIT')
  assert.equal(codeOf({ failure: { code: 'TIMEOUT' } }), 'TIMEOUT')
  assert.equal(codeOf(new Error('plain')), undefined)
  assert.equal(codeOf(null), undefined)
})

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test('settings normalization drops unusable chains and routes', () => {
  const settings = normalizeSettings({
    chains: [
      { id: 'good', routes: [{ provider: 'a', model: '1' }, { provider: 'a', model: '1' }, { provider: '', model: 'x' }] },
      { id: 'model-rotation', routes: [{ provider: 'a', model: '1' }] },
      { id: 'empty', routes: [] },
      { id: 'dup', routes: [{ provider: 'b', model: '2' }] },
      { id: 'dup', routes: [{ provider: 'c', model: '3' }] },
      'not an object',
    ],
  })
  assert.deepEqual(settings.chains.map(c => c.id), ['good', 'empty', 'dup'])
  assert.equal(settings.chains[0].routes.length, 1, 'duplicate route removed')
  assert.equal(settings.chains[1].routes.length, 0, 'an empty chain is kept so it can be edited')
})

test('a chain may not shadow the plugin route', () => {
  assert.equal(normalizeChain({ id: ROUTER_PROVIDER, routes: [] }), undefined)
})

test('an unreadable settings file falls back to defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-store-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, '{ this is not json', 'utf8')
  const store = new SettingsStore(file)
  const { settings, error } = store.read()
  assert.deepEqual(settings.chains, [])
  assert.ok(typeof error === 'string' && error.length > 0, 'the read diagnostic must be reported')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('write then read round-trips through the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-store-'))
  const file = path.join(dir, 'settings.json')
  const store = new SettingsStore(file)
  store.write({ chains: [{ id: 'main', name: '主链', routes: [{ provider: 'a', model: '1' }] }] })
  const { settings } = store.read()
  assert.equal(settings.chains.length, 1)
  assert.equal(settings.chains[0].name, '主链')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// commit and progress rules
// ---------------------------------------------------------------------------

test('the first visible output commits the attempt', () => {
  assert.equal(commitsAttempt({ type: 'text-delta', text: 'hi' }), true)
  assert.equal(commitsAttempt({ type: 'text-delta', text: '' }), false)
  assert.equal(commitsAttempt({ type: 'text-delta', text: '   ' }), false, 'whitespace is not visible output')
  assert.equal(commitsAttempt({ type: 'tool-call-delta' }), true)
})

test('a block-start never commits, even for a text block', () => {
  // The block may turn out to be empty, so opening it is not a commitment: a
  // route that opens a block and dies must still be switchable.
  assert.equal(commitsAttempt({ type: 'block-start', block: { type: 'text' } }), false)
  assert.equal(commitsAttempt({ type: 'block-start', block: { type: 'reasoning' } }), false)
})

test('a completed text block commits only when it has content', () => {
  assert.equal(commitsAttempt({ type: 'block-end', block: { type: 'text', text: 'done' } }), true)
  assert.equal(commitsAttempt({ type: 'block-end', block: { type: 'text', text: '' } }), false)
  assert.equal(commitsAttempt({ type: 'block-end', block: { type: 'reasoning' } }), false)
})

test('reasoning and usage do not commit', () => {
  assert.equal(commitsAttempt({ type: 'reasoning-delta', text: 'thinking' }), false)
  assert.equal(commitsAttempt({ type: 'usage', tokens: 5 }), false)
  assert.equal(commitsAttempt({ type: 'block-end', block: { type: 'reasoning' } }), false)
})

test('carriesProgress ignores empty and whitespace-only deltas', () => {
  assert.equal(carriesProgress({ type: 'text-delta', text: '' }), false)
  assert.equal(carriesProgress({ type: 'text-delta', text: 'a' }), true)
  assert.equal(carriesProgress({ type: 'usage' }), false)
})

test('a stream ending without a finish is classified, not reported as success', () => {
  assert.equal(classifyUnfinishedStream({ committed: false, sawFinish: false, sawAnyChunk: false }).code, 'EMPTY_RESPONSE')
  assert.equal(classifyUnfinishedStream({ committed: true, sawFinish: false, sawAnyChunk: true }).code, 'STREAM_CLOSED')
  assert.equal(classifyUnfinishedStream({ committed: false, sawFinish: false, sawAnyChunk: true }).code, 'STREAM_CLOSED')
})

// ---------------------------------------------------------------------------
// attempt streaming
// ---------------------------------------------------------------------------

test('an attempt forwards a clean answer and reports success', async () => {
  const attempt = runAttempt(streamOf([{ type: 'text-delta', text: 'hello' }, { type: 'finish', reason: { kind: 'stop' } }]))
  const { chunks, outcome } = await drain(attempt)
  assert.equal(outcome.kind, 'answer')
  assert.equal(chunks.filter(c => c.type === 'finish').length, 1)
})

test('uncommitted chunks are dropped when the route dies', async () => {
  const error = Object.assign(new Error('died'), { code: 'TRANSPORT' })
  const attempt = runAttempt(
    streamOf([{ type: 'reasoning-delta', text: 'thinking' }, { type: 'usage', tokens: 3 }], error),
  )
  const { chunks, outcome } = await drain(attempt)
  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.code, 'TRANSPORT')
  assert.equal(chunks.length, 0, 'nothing visible was produced, so nothing may leak')
})

test('committed chunks are forwarded before the failure surfaces', async () => {
  const error = Object.assign(new Error('died'), { code: 'TRANSPORT' })
  const attempt = runAttempt(streamOf([{ type: 'text-delta', text: 'half an answer' }], error))
  const { chunks, outcome } = await drain(attempt)
  assert.equal(outcome.kind, 'failed')
  assert.equal(chunks.length, 1, 'the visible text must have reached the reader')
  assert.equal(chunks[0].text, 'half an answer')
})

test('a failure carried by the finish reason is reported with its code', async () => {
  const attempt = runAttempt(
    streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }]),
  )
  const { outcome } = await drain(attempt)
  assert.equal(outcome.code, 'RATE_LIMIT')
  assert.equal(outcome.message, 'slow down')
})

test('an aborted signal ends the attempt as aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const attempt = runAttempt(streamOf([{ type: 'text-delta', text: 'x' }]), { signal: controller.signal })
  const { outcome } = await drain(attempt)
  assert.equal(outcome.kind, 'aborted')
})

test('aborting mid-stream closes the upstream', async () => {
  const controller = new AbortController()
  const { iterable, state } = trackedStream([{ type: 'text-delta', text: 'a' }])
  const attempt = runAttempt(iterable, { signal: controller.signal })
  const chunks = []
  for await (const chunk of attempt.chunks) {
    chunks.push(chunk)
    controller.abort()
  }
  const outcome = await attempt.outcome
  assert.equal(outcome.kind, 'aborted')
  assert.equal(state.closed, true, 'the upstream must be closed on abort')
})

test('a consumer that stops early still settles and closes the upstream', async () => {
  const { iterable, state } = trackedStream([{ type: 'text-delta', text: 'a' }, { type: 'text-delta', text: 'b' }])
  const attempt = runAttempt(iterable)
  // Read one chunk then abandon the stream.
  const iterator = attempt.chunks[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return?.()
  const outcome = await attempt.outcome
  assert.equal(outcome.kind, 'aborted', 'an abandoned attempt must not report success')
  assert.equal(state.closed, true)
})

test('the idle watchdog fires on a silent upstream', async () => {
  const { iterable, state } = trackedStream([], { hang: true })
  const attempt = runAttempt(iterable, { idleTimeoutMs: 60 })
  const { outcome } = await drain(attempt)
  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.code, 'TIMEOUT')
  assert.equal(state.closed, true, 'a timed-out upstream must be closed')
})

// ---------------------------------------------------------------------------
// capability gating
// ---------------------------------------------------------------------------

test('an image request is detected in user messages and tool results', () => {
  assert.equal(requestHasImage([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), false)
  assert.equal(requestHasImage([{ role: 'user', content: [{ type: 'image', data: 'x' }] }]), true)
  assert.equal(
    requestHasImage([
      { role: 'user', content: [{ type: 'tool-result', content: [{ type: 'image', data: 'x' }] }] },
    ]),
    true,
  )
})

test('a text-only route is skipped for an image request', () => {
  const verdict = routeCanServe({ inputModalities: ['text'], contextWindow: 128000 }, { needsImage: true, inputTokens: 10 })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /image/)
})

test('a vision route is accepted for an image request', () => {
  const verdict = routeCanServe(
    { inputModalities: ['text', 'image'], contextWindow: 128000 },
    { needsImage: true, inputTokens: 10 },
  )
  assert.equal(verdict.ok, true)
})

test('an unknown modality does not reject the route', () => {
  const verdict = routeCanServe(undefined, { needsImage: true, inputTokens: 10 })
  assert.equal(verdict.ok, true, 'unknown capability must not silently shrink the chain')
})

test('a route whose window cannot hold the request is skipped', () => {
  const verdict = routeCanServe({ contextWindow: 1000 }, { needsImage: false, inputTokens: 5000 })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /window/)
})

test('token estimation grows with content and tools', () => {
  const small = estimateRequestTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], [])
  const large = estimateRequestTokens(
    [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] }],
    [{ name: 't', description: 'd', parameters: { type: 'object' } }],
  )
  assert.ok(large > small)
})

test('CJK text is not counted at the Latin rate', () => {
  // A Chinese character costs about one token, not a quarter. Counting it at the
  // Latin rate understated a Chinese request ~4x and let requests that would
  // overflow the window pass the gate.
  const chinese = '这是一段中文文本用来测试token估算的准确性'
  const latin = 'x'.repeat(chinese.length)
  const chineseTokens = estimateRequestTokens([{ role: 'user', content: [{ type: 'text', text: chinese }] }], [])
  const latinTokens = estimateRequestTokens([{ role: 'user', content: [{ type: 'text', text: latin }] }], [])
  assert.ok(chineseTokens > latinTokens * 3, 'chinese=' + chineseTokens + ' latin=' + latinTokens)
  assert.ok(chineseTokens >= chinese.length * 0.8, 'chinese tokens should approach one per character')
})

test('Japanese and Korean are counted as wide text', () => {
  const ja = 'これは日本語のテキストです'
  const ko = '이것은 한국어 텍스트입니다'
  for (const text of [ja, ko]) {
    const tokens = estimateRequestTokens([{ role: 'user', content: [{ type: 'text', text }] }], [])
    assert.ok(tokens >= text.length * 0.8, text + ' -> ' + tokens)
  }
})

test('ASCII code is counted at roughly four characters per token', () => {
  const code = 'const x = foo.bar(1, 2);'
  const tokens = estimateRequestTokens([{ role: 'user', content: [{ type: 'text', text: code }] }], [])
  assert.ok(tokens <= Math.ceil(code.length / 4) + 2, 'tokens=' + tokens)
})

test('requirementsOf collects image, tool and size needs', () => {
  const need = requirementsOf({
    messages: [{ role: 'user', content: [{ type: 'image', data: 'x' }] }],
    tools: [{ name: 't' }],
    maxTokens: 100,
  })
  assert.equal(need.needsImage, true)
  assert.equal(need.needsTools, true)
  assert.equal(need.reservedOutputTokens, 100)
})

// ---------------------------------------------------------------------------
// adapter: failover behaviour
// ---------------------------------------------------------------------------

test('the first healthy route answers and later routes are never touched', async () => {
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'text-delta', text: 'first' }, { type: 'finish', reason: { kind: 'stop' } }] },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'second' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)
  assert.equal(chunks[0].text, 'first')
  assert.deepEqual(llm.calls.map(c => c.key), ['p1/a'])
  cleanup()
})

test('a rate-limited head falls over to the next route', async () => {
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'rescued' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)
  assert.equal(chunks[0].text, 'rescued')
  assert.deepEqual(llm.calls.map(c => c.key), ['p1/a', 'p2/b'])
  cleanup()
})

test('a route that only thought before dying is discarded silently', async () => {
  const llm = fakeLlm({
    'p1/a': {
      chunks: [{ type: 'reasoning-delta', text: 'thinking hard' }],
      throw: Object.assign(new Error('died'), { code: 'TRANSPORT' }),
    },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'complete' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const text = []
  for await (const chunk of prepared.stream({ messages: [] })) {
    if (chunk.type === 'text-delta') text.push(chunk.text)
  }
  assert.equal(text.join(''), 'complete', 'only the surviving route contributes text')
  cleanup()
})

test('an abandoned block never reaches the host half-open', async () => {
  // `block-start` does not commit, so a route that opens a block and dies must
  // not leave the transcript with an unterminated block. This asserts on what the
  // host actually receives, not on the commit decision.
  const llm = fakeLlm({
    'p1/a': {
      stream: () =>
        (async function* () {
          yield { type: 'block-start', block: { type: 'text' } }
          throw Object.assign(new Error('died mid-block'), { code: 'TRANSPORT' })
        })(),
    },
    'p2/b': {
      chunks: [
        { type: 'block-start', block: { type: 'text' } },
        { type: 'text-delta', text: 'backup answer' },
        { type: 'block-end', block: { type: 'text', text: 'backup answer' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)

  let depth = 0
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') depth += 1
    if (chunk.type === 'block-end') depth -= 1
    assert.ok(depth >= 0, 'a block-end must never precede its block-start')
  }
  assert.equal(depth, 0, 'every block the host saw must be closed')
  assert.equal(
    chunks.filter(c => c.type === 'block-start').length,
    1,
    'only the surviving route may open a block',
  )
  cleanup()
})

test('a failure after commit ends the turn instead of switching', async () => {
  const llm = fakeLlm({
    'p1/a': {
      chunks: [{ type: 'text-delta', text: 'half' }],
      throw: Object.assign(new Error('died'), { code: 'TRANSPORT' }),
    },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'should not run' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.deepEqual(llm.calls.map(c => c.key), ['p1/a'], 'a committed route must not be replaced')
  assert.equal(chunks.filter(c => c.type === 'finish').length, 1, 'exactly one terminal chunk')
  cleanup()
})

test('a terminal failure stops the walk instead of trying the rest', async () => {
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } }] },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'should not run' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.failure.code, 'AUTH')
  assert.deepEqual(llm.calls.map(c => c.key), ['p1/a'], 'AUTH must not fall over')
  cleanup()
})

test('when every route fails the error names them all', async () => {
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
    'p2/b': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /p1\/a/)
  assert.match(finish.reason.failure.message, /p2\/b/)
  assert.equal(chunks.filter(c => c.type === 'finish').length, 1)
  cleanup()
})

test('an unknown chain yields one terminal error', async () => {
  const { adapter, cleanup } = adapterWith([], fakeLlm({}))
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'nope')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.failure.code, 'UNKNOWN_MODEL')
  cleanup()
})

test('the request body survives the hop', async () => {
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith([{ id: 'main', routes: [{ provider: 'p1', model: 'a' }] }], llm)
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'be terse' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ]
  const tools = [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }]
  const controller = new AbortController()
  for await (const _chunk of prepared.stream({ messages, tools, signal: controller.signal })) {
    // drain
  }
  const forwarded = llm.calls[0].forwarded
  assert.equal(forwarded.messageCount, 2, 'messages must reach the route')
  assert.deepEqual(forwarded.toolNames, ['read_file'], 'tool declarations must reach the route')
  assert.equal(forwarded.hasSignal, true, 'the cancellation signal must reach the route')
  cleanup()
})

test("this plugin's own knobs are not forwarded to the downstream provider", async () => {
  // `idleTimeoutMs` is read by this adapter. Forwarding it would hand a provider
  // a field it never defined, and a strict provider would reject the request.
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith([{ id: 'main', routes: [{ provider: 'p1', model: 'a' }] }], llm)
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  for await (const _chunk of prepared.stream({
    messages: [],
    idleTimeoutMs: 5000,
    timeoutMs: 5000,
  })) {
    // drain
  }
  const forwarded = llm.calls[0].forwarded
  assert.equal(forwarded.hasIdleTimeout, false, 'idleTimeoutMs must not reach the provider')
  assert.equal(forwarded.hasTimeout, false, 'timeoutMs must not reach the provider')
  cleanup()
})

test('a route without image support is skipped for an image request', async () => {
  const llm = fakeLlm(
    {
      'p1/a': { chunks: [{ type: 'text-delta', text: 'text-only' }, { type: 'finish', reason: { kind: 'stop' } }] },
      'p2/b': { chunks: [{ type: 'text-delta', text: 'vision' }, { type: 'finish', reason: { kind: 'stop' } }] },
    },
    {
      info: provider =>
        provider === 'p1'
          ? { context: { contextWindow: 128000 }, inputModalities: ['text'] }
          : { context: { contextWindow: 128000 }, inputModalities: ['text', 'image'] },
    },
  )
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  const messages = [{ role: 'user', content: [{ type: 'image', data: 'x' }] }]
  for await (const chunk of prepared.stream({ messages })) chunks.push(chunk)
  assert.equal(chunks[0].text, 'vision')
  assert.deepEqual(llm.calls.map(c => c.key), ['p2/b'], 'the text-only route must be skipped')
  cleanup()
})

test('every route failing a capability gate reports a summary', async () => {
  const llm = fakeLlm(
    { 'p1/a': { chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] } },
    { info: () => ({ context: { contextWindow: 100 }, inputModalities: ['text'] }) },
  )
  const { adapter, cleanup } = adapterWith([{ id: 'main', routes: [{ provider: 'p1', model: 'a' }] }], llm)
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(8000) }] }]
  for await (const chunk of prepared.stream({ messages })) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /skipped/)
  cleanup()
})

test('a user abort ends the walk without trying the next route', async () => {
  const controller = new AbortController()
  const llm = fakeLlm({
    'p1/a': {
      stream: () =>
        (async function* () {
          yield { type: 'text-delta', text: 'a' }
          controller.abort()
          yield { type: 'text-delta', text: 'b' }
        })(),
    },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'should not run' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [], signal: controller.signal })) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason?.kind, 'aborted')
  assert.deepEqual(llm.calls.map(c => c.key), ['p1/a'], 'an abort must not advance the chain')
  cleanup()
})

test('concurrent calls to the same chain do not share state', async () => {
  let counter = 0
  const llm = fakeLlm({
    'p1/a': {
      stream: () =>
        (async function* () {
          counter += 1
          const tag = 'call' + counter
          yield { type: 'text-delta', text: tag }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
    },
  })
  const { adapter, cleanup } = adapterWith([{ id: 'main', routes: [{ provider: 'p1', model: 'a' }] }], llm)
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')

  const read = async () => {
    const out = []
    for await (const chunk of prepared.stream({ messages: [] })) {
      if (chunk.type === 'text-delta') out.push(chunk.text)
    }
    return out.join('')
  }
  const [a, b, c] = await Promise.all([read(), read(), read()])
  assert.equal(new Set([a, b, c]).size, 3, 'each concurrent call must get its own answer')
  cleanup()
})

test('listModels exposes enabled chains only', async () => {
  const { adapter, cleanup } = adapterWith(
    [
      { id: 'on', name: '启用', enabled: true, routes: [{ provider: 'p1', model: 'a' }] },
      { id: 'off', name: '停用', enabled: false, routes: [{ provider: 'p1', model: 'a' }] },
    ],
    fakeLlm({}),
  )
  assert.deepEqual((await adapter.listModels()).map(m => m.id), ['on'])
  cleanup()
})

// ---------------------------------------------------------------------------
// vision: a chain must not claim to be blind when it is not
// ---------------------------------------------------------------------------

/** Build an adapter whose routes report the given modalities per provider. */
function visionAdapter(modalitiesByKey, routes) {
  const llm = fakeLlm({}, {
    info: (provider, model) => {
      const key = provider + '/' + model
      const modalities = modalitiesByKey[key]
      return {
        context: { contextWindow: 1_000_000 },
        ...(modalities === undefined ? {} : { inputModalities: modalities }),
      }
    },
  })
  return adapterWith([{ id: 'main', name: '日常', routes }], llm)
}

test('a chain over vision routes advertises image input', async () => {
  // The host reads this list to decide whether to offer images at all, so a
  // hard-coded ['text'] silently disabled pictures for the whole route.
  const { adapter, cleanup } = visionAdapter(
    { 'p1/a': ['text', 'image'] },
    [{ provider: 'p1', model: 'a' }],
  )
  const resolved = await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.ok(Array.isArray(resolved.inputModalities), 'the chain must declare modalities')
  assert.ok(resolved.inputModalities.includes('image'), JSON.stringify(resolved.inputModalities))
  cleanup()
})

test('listModels reports image input for a vision chain', async () => {
  // This is the list the picker and the upload surface read. It used to be
  // fixed to ['text'] regardless of the routes behind it.
  const { adapter, cleanup } = visionAdapter(
    { 'p1/a': ['text', 'image'] },
    [{ provider: 'p1', model: 'a' }],
  )
  const models = await adapter.listModels()
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  cleanup()
})

test('a chain whose routes disclose nothing does not claim to be blind', async () => {
  // Unknown is not "cannot see". The host only flattens images when the list is
  // PRESENT and lacks 'image', so reporting ['text'] here is what broke image
  // input for custom proxies that disclose no modalities.
  const { adapter, cleanup } = visionAdapter({}, [{ provider: 'p1', model: 'a' }])
  const resolved = await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.equal(resolved.inputModalities, undefined, 'unknown must stay unknown')
  const models = await adapter.listModels()
  assert.equal(models[0].inputModalities, undefined, 'the picker entry must not claim text-only either')
  cleanup()
})

test('an unknown chain does not claim to be blind', async () => {
  // The early return for a missing chain used to carry inputModalities: ['text'].
  const { adapter, cleanup } = adapterWith([], fakeLlm({}))
  const resolved = await adapter.resolveModel(ROUTER_PROVIDER, 'nope')
  assert.equal(resolved.inputModalities, undefined)
  cleanup()
})

test('a mixed chain sees images when any route can', async () => {
  // The chain is offered as one model. If one route can see, the request must be
  // allowed through so the capability gate can pick that route.
  const { adapter, cleanup } = visionAdapter(
    { 'p1/a': ['text'], 'p2/b': ['text', 'image'] },
    [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }],
  )
  const resolved = await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.ok(resolved.inputModalities.includes('image'), JSON.stringify(resolved.inputModalities))
  cleanup()
})

test('a chain of explicitly text-only routes still says text only', async () => {
  // The opposite error: if every route DOES declare text-only, saying so is
  // correct and lets the host flatten the image instead of failing upstream.
  const { adapter, cleanup } = visionAdapter(
    { 'p1/a': ['text'] },
    [{ provider: 'p1', model: 'a' }],
  )
  const resolved = await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.deepEqual(resolved.inputModalities, ['text'])
  cleanup()
})

test('an image request is routed only to the vision route', async () => {
  // End to end: the chain advertises vision, and the gate must skip the blind
  // route rather than sending the picture to it.
  const llm = fakeLlm(
    {
      'p1/a': { chunks: [{ type: 'text-delta', text: 'blind' }, { type: 'finish', reason: { kind: 'stop' } }] },
      'p2/b': { chunks: [{ type: 'text-delta', text: 'sighted' }, { type: 'finish', reason: { kind: 'stop' } }] },
    },
    {
      info: provider =>
        provider === 'p1'
          ? { context: { contextWindow: 1_000_000 }, inputModalities: ['text'] }
          : { context: { contextWindow: 1_000_000 }, inputModalities: ['text', 'image'] },
    },
  )
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
  )
  const resolved = await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.ok(resolved.inputModalities.includes('image'))

  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  const messages = [{ role: 'user', content: [{ type: 'image', data: 'x' }] }]
  for await (const chunk of prepared.stream({ messages })) chunks.push(chunk)
  assert.equal(chunks[0].text, 'sighted')
  assert.deepEqual(llm.calls.map(call => call.key), ['p2/b'], 'the blind route must be skipped')
  cleanup()
})

test('resolveModel reports the widest context window of the chain', async () => {  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-adapter-'))
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  store.write({ chains: [{ id: 'wide', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }] })
  const adapter = new RotationAdapter({ store })
  adapter.ctx = {
    llm: {
      async resolveModelInfo(provider) {
        return { context: { contextWindow: provider === 'p1' ? 128000 : 1000000 }, inputModalities: ['text'] }
      },
    },
  }
  const info = await adapter.resolveModel(ROUTER_PROVIDER, 'wide')
  assert.equal(info.context?.contextWindow, 1000000)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the failure summary names skipped routes with their reason', () => {
  const summary = summarizeFailure(
    'main',
    [{ route: { provider: 'p1', model: 'a' }, code: 'RATE_LIMIT' }],
    [{ route: { provider: 'p2', model: 'b' }, reason: 'route cannot accept images' }],
  )
  assert.match(summary, /p1\/a: RATE_LIMIT/)
  assert.match(summary, /p2\/b: skipped/)
  assert.match(summary, /images/)
})

test('a walk where every route rejects the length explains what to do', () => {
  // The plain summary names the routes but leaves the user stuck: the obvious
  // next move — try another provider — is what the chain already did. This is
  // the 1M-window case where every route reports the same code.
  const summary = summarizeFailure(
    'main',
    [
      { route: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' }, code: 'CONTEXT_WINDOW_EXCEEDED' },
      { route: { provider: 'wb-proxy', model: 'glm-5.3-flash' }, code: 'CONTEXT_WINDOW_EXCEEDED' },
    ],
    [],
    { inputTokens: 1_050_000 },
  )
  assert.match(summary, /wb-proxy\/deepseek-v4\.1-flash: CONTEXT_WINDOW_EXCEEDED/)
  assert.match(summary, /wb-proxy\/glm-5\.3-flash: CONTEXT_WINDOW_EXCEEDED/)
  assert.match(summary, /换厂商不会更宽松/, 'the hint must rule out the useless move')
  assert.match(summary, /新会话/, 'the hint must offer an action')
  assert.match(summary, /1050K/, 'the hint should quantify the request')
})

test('a mixed failure does not claim the length was the cause', () => {
  // One route timed out and another rejected the length. Telling the user to
  // shorten the conversation would be wrong advice about half the failures.
  const summary = summarizeFailure(
    'main',
    [
      { route: { provider: 'p1', model: 'a' }, code: 'TIMEOUT' },
      { route: { provider: 'p2', model: 'b' }, code: 'CONTEXT_WINDOW_EXCEEDED' },
    ],
    [],
    { inputTokens: 900_000 },
  )
  assert.doesNotMatch(summary, /换厂商不会更宽松/)
  assert.doesNotMatch(summary, /新会话/)
})

test('a length hint is not added when nothing was attempted', () => {
  // An empty walk has no code to attribute, and the summary already says the
  // chain has no usable route.
  const summary = summarizeFailure('main', [], [])
  assert.equal(summary, 'rotation chain "main" has no usable route')
  assert.doesNotMatch(summary, /换厂商/)
})

test('an all-length walk names the size only when it is known', () => {
  const withoutSize = summarizeFailure(
    'main',
    [{ route: { provider: 'p1', model: 'a' }, code: 'CONTEXT_WINDOW_EXCEEDED' }],
    [],
  )
  assert.match(withoutSize, /新会话/)
  assert.doesNotMatch(withoutSize, /K tokens/)
})

test('failover hooks report the switch and the final failure', async () => {
  const events = []
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const { adapter, cleanup } = adapterWith(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    llm,
    {
      onSwitch: event => events.push({ kind: 'switch', ...event }),
      onFailure: event => events.push({ kind: 'failure', ...event }),
    },
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  for await (const _chunk of prepared.stream({ messages: [] })) {
    // drain
  }
  const switched = events.find(e => e.kind === 'switch')
  assert.ok(switched, 'a switch must be reported')
  assert.equal(switched.to.model, 'b')
  assert.equal(switched.reason, 'RATE_LIMIT')
  cleanup()
})

// ---------------------------------------------------------------------------
// request log
// ---------------------------------------------------------------------------

test('an answered walk is recorded with the route that served it', async () => {
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-log-'))
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  store.write({ chains: [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }] })
  const requestLog = new RequestLog({ file: path.join(dir, 'request-log.json') })
  const adapter = new RotationAdapter({ store, requestLog })
  adapter.ctx = { llm }

  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  for await (const _chunk of prepared.stream({ messages: [] })) {
    // drain
  }

  const entries = requestLog.read()
  assert.equal(entries.length, 1, 'one answered walk is one entry')
  assert.equal(entries[0].outcome, 'answered')
  assert.equal(entries[0].provider, 'p2')
  assert.equal(entries[0].model, 'b')
  assert.equal(entries[0].tried[0].code, 'RATE_LIMIT', 'the failed attempt is kept as context')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a failed walk is recorded once, naming the last route tried', async () => {
  // The settings card keeps only the newest failure and the Host logger does not
  // persist info lines, so without this entry the failure leaves no trace after
  // a restart.
  const llm = fakeLlm({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
    'p2/b': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } }] },
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-log-'))
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  store.write({ chains: [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }] })
  const requestLog = new RequestLog({ file: path.join(dir, 'request-log.json') })
  const adapter = new RotationAdapter({ store, requestLog })
  adapter.ctx = { llm }

  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  for await (const _chunk of prepared.stream({ messages: [] })) {
    // drain
  }

  const entries = requestLog.read()
  assert.equal(entries.length, 1, 'one failed walk is one entry, not one per route')
  assert.equal(entries[0].outcome, 'failed')
  assert.equal(entries[0].provider, 'p2')
  assert.equal(entries[0].code, 'SERVER')
  assert.equal(entries[0].tried.length, 2, 'every attempt is kept')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the request log excludes prompt content', () => {
  // A log that recorded messages would leak prompts into a file the user may
  // share when reporting a bug.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-log-'))
  const requestLog = new RequestLog({ file: path.join(dir, 'request-log.json') })
  requestLog.record({
    chainId: 'main',
    provider: 'p1',
    model: 'a',
    elapsedMs: 5,
    outcome: 'answered',
    messages: [{ role: 'user', content: 'a secret prompt' }],
  })
  const raw = fs.readFileSync(path.join(dir, 'request-log.json'), 'utf8')
  assert.doesNotMatch(raw, /secret prompt/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the request log survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-log-'))
  const file = path.join(dir, 'request-log.json')
  new RequestLog({ file }).record({ chainId: 'main', provider: 'p1', model: 'a', elapsedMs: 3 })

  // A second instance stands in for the next process: the point of writing to
  // disk is that this fact is still there.
  const reopened = new RequestLog({ file })
  const entries = reopened.read()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].model, 'a')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a corrupt request log is discarded rather than fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-log-'))
  const file = path.join(dir, 'request-log.json')
  fs.writeFileSync(file, '{not json', 'utf8')
  const requestLog = new RequestLog({ file })
  assert.deepEqual(requestLog.read(), [], 'a bad file must not break routing')
  // And it must still be writable afterwards.
  requestLog.record({ chainId: 'main', provider: 'p1', model: 'a', elapsedMs: 1 })
  assert.equal(requestLog.read().length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the request log is bounded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-log-'))
  const requestLog = new RequestLog({ file: path.join(dir, 'request-log.json') })
  for (let index = 0; index < 260; index += 1) {
    requestLog.record({ chainId: 'main', provider: 'p1', model: 'm' + index, elapsedMs: 1 })
  }
  assert.equal(requestLog.size, 200, 'the log must not grow without bound')
  assert.equal(requestLog.read().at(-1).model, 'm259', 'the newest entry is kept')
  fs.rmSync(dir, { recursive: true, force: true })
})
