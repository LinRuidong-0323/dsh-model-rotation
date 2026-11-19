/**
 * Assertions for the in-flight counter and the diagnostics the settings card
 * shows.
 *
 * A leaked counter is a quiet failure: the card would claim a request is still
 * running forever, and the user would have no way to tell it apart from a real
 * hung turn. Every exit path is therefore checked, including the ones that
 * abandon the generator mid-stream.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RotationAdapter } from '../src/adapter.js'
import { SettingsStore, ROUTER_PROVIDER } from '../src/config.js'

/** Build an adapter over the given routes, with a counter mirroring the plugin. */
function build(routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-inflight-'))
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  store.write({
    chains: [
      {
        id: 'main',
        routes: Object.keys(routes).map(key => {
          const [provider, model] = key.split('/')
          return { provider, model }
        }),
      },
    ],
  })

  const state = { inFlight: 0, max: 0, hits: [], failures: [] }
  const adapter = new RotationAdapter({
    store,
    hooks: {
      onAttemptStart: () => {
        state.inFlight += 1
        state.max = Math.max(state.max, state.inFlight)
      },
      onAttemptEnd: () => {
        state.inFlight = Math.max(0, state.inFlight - 1)
      },
      onSwitch: event => state.hits.push(event),
      onFailure: event => state.failures.push(event),
    },
  })
  adapter.ctx = {
    llm: {
      async prepareCall(config) {
        const key = config.provider + '/' + config.model
        const spec = routes[key]
        if (!spec) throw Object.assign(new Error('no route'), { code: 'NO_ADAPTER' })
        return {
          config: { provider: config.provider, model: config.model },
          stream: () =>
            (async function* () {
              for (const chunk of spec.chunks ?? []) yield chunk
            })(),
        }
      },
      async resolveModelInfo() {
        return { context: { contextWindow: 200000 }, inputModalities: ['text'] }
      },
    },
  }
  return { adapter, state, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Drain one chain call. */
async function drain(adapter, options = {}) {
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [], ...options })) chunks.push(chunk)
  return chunks
}

test('the counter returns to zero after a successful answer', async () => {
  const { adapter, state, cleanup } = build({
    'p1/a': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  await drain(adapter)
  assert.equal(state.inFlight, 0)
  assert.equal(state.max, 1, 'one attempt at a time')
  cleanup()
})

test('the counter returns to zero after a failover', async () => {
  const { adapter, state, cleanup } = build({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  await drain(adapter)
  assert.equal(state.inFlight, 0)
  assert.equal(state.max, 1, 'the failing attempt ends before the next begins')
  cleanup()
})

test('the counter returns to zero when prepareCall throws', async () => {
  const { adapter, state, cleanup } = build({})
  await drain(adapter)
  assert.equal(state.inFlight, 0)
  cleanup()
})

test('the counter returns to zero when the reader abandons the stream', async () => {
  // This is the leak case: the generator is suspended at a `yield`, and only the
  // `finally` around the consume loop can decrement.
  const { adapter, state, cleanup } = build({
    'p1/a': {
      chunks: [
        { type: 'text-delta', text: 'a' },
        { type: 'text-delta', text: 'b' },
        { type: 'text-delta', text: 'c' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  })
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const iterator = prepared.stream({ messages: [] })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()
  await iterator.return?.()
  assert.equal(state.inFlight, 0)
  cleanup()
})

test('the counter returns to zero after a cancellation', async () => {
  const controller = new AbortController()
  const { adapter, state, cleanup } = build({
    'p1/a': { chunks: [{ type: 'text-delta', text: 'a' }, { type: 'text-delta', text: 'b' }] },
  })
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  for await (const _chunk of prepared.stream({ messages: [], signal: controller.signal })) {
    controller.abort()
  }
  assert.equal(state.inFlight, 0)
  cleanup()
})

test('the counter returns to zero when every route fails', async () => {
  const { adapter, state, cleanup } = build({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } }] },
    'p2/b': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } }] },
  })
  await drain(adapter)
  assert.equal(state.inFlight, 0)
  cleanup()
})

test('concurrent calls report a peak above one', async () => {
  const { adapter, state, cleanup } = build({
    'p1/a': {
      chunks: [
        { type: 'text-delta', text: 'a' },
        { type: 'text-delta', text: 'b' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  })
  await Promise.all([drain(adapter), drain(adapter), drain(adapter)])
  assert.equal(state.inFlight, 0, 'all three must release their slot')
  assert.ok(state.max >= 2, 'concurrent calls should overlap, saw peak ' + state.max)
  cleanup()
})

test('a switch reports from, to and reason', async () => {
  const { adapter, state, cleanup } = build({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
    'p2/b': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] },
  })
  await drain(adapter)
  assert.equal(state.hits.length, 1)
  assert.deepEqual(state.hits[0].to, { provider: 'p2', model: 'b' })
  assert.equal(state.hits[0].reason, 'RATE_LIMIT')
  cleanup()
})

test('a failure records the full attempt summary', async () => {
  const { adapter, state, cleanup } = build({
    'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
    'p2/b': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } }] },
  })
  await drain(adapter)
  assert.equal(state.failures.length, 1)
  const failure = state.failures[0]
  assert.match(failure.summary, /p1\/a/)
  assert.match(failure.summary, /p2\/b/)
  cleanup()
})
