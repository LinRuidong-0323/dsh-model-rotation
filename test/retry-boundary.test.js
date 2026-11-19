/**
 * Verify the responsibility boundary with `dsh-llm-retry`.
 *
 * The two must not multiply: this plugin walks the chain inside one request, and
 * `dsh-llm-retry` re-runs a failed step. If this adapter also declared a retry
 * policy, the host would stack its own retry loop on top of the walk and one
 * rate-limited chain could turn into N×M provider calls.
 *
 * The contract asserted here:
 *   - `providerRetryPolicy()` returns undefined, so the host default applies and
 *     this adapter owns no retry loop of its own;
 *   - one walk makes at most one attempt per route (no unbounded repetition);
 *   - a walk that ends in failure surfaces exactly one terminal chunk, which is
 *     what `dsh-llm-retry` reacts to.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const BASE = 'file:///D:/Deeseek_HARENSS/创建插件/dsh-model-rotation'
const { RotationAdapter } = await import(BASE + '/src/adapter.js')
const { SettingsStore, ROUTER_PROVIDER } = await import(BASE + '/src/config.js')
const { CooldownTable } = await import(BASE + '/src/cooldown.js')

/** Build an adapter whose routes are counted. */
function build(routes, chains, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-retry-'))
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  store.write({ chains })
  const calls = []
  // A supplied clock lets a test advance past a cooldown without waiting.
  const adapter = new RotationAdapter({ store, ...(now === undefined ? {} : { cooldown: new CooldownTable({ now }) }) })
  adapter.ctx = {
    llm: {
      async prepareCall(config) {
        const key = config.provider + '/' + config.model
        calls.push(key)
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
  return { adapter, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Drain one chain call. */
async function walk(adapter, chainId) {
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, chainId)
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)
  return chunks
}

test('the adapter declares no provider retry policy', () => {
  const { adapter, cleanup } = build({}, [])
  // Declaring one would stack the host's retry executor on top of the walk.
  assert.equal(adapter.providerRetryPolicy(), undefined)
  cleanup()
})

test('one walk attempts each route at most once', async () => {
  const { adapter, calls, cleanup } = build(
    {
      'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
      'p2/b': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
    },
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
  )
  await walk(adapter, 'main')
  assert.deepEqual(calls, ['p1/a', 'p2/b'], 'each route exactly once, in order')
  cleanup()
})

test('a failing walk produces exactly one terminal chunk for llm-retry to see', async () => {
  const { adapter, cleanup } = build(
    { 'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } }] } },
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }] }],
  )
  const chunks = await walk(adapter, 'main')
  assert.equal(chunks.filter(c => c.type === 'finish').length, 1)
  cleanup()
})

test('a walk that succeeds produces exactly one terminal chunk', async () => {
  const { adapter, cleanup } = build(
    { 'p1/a': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] } },
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }] }],
  )
  const chunks = await walk(adapter, 'main')
  assert.equal(chunks.filter(c => c.type === 'finish').length, 1)
  cleanup()
})

test('a re-entry walks the chain again rather than resuming mid-way', async () => {
  // `dsh-llm-retry` re-enters with a fresh walk. It must not resume from where the
  // first walk stopped; it starts from the chain's current head.
  //
  // Since 0.2.5 a failed route cools down, so the re-entry's head is the next
  // healthy route rather than the one that just failed. That is the intended
  // behaviour: retrying a rate-limited route immediately would burn another call
  // to learn the same thing.
  const { adapter, calls, cleanup } = build(
    {
      'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
      'p2/b': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] },
    },
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
  )
  await walk(adapter, 'main')
  await walk(adapter, 'main')
  assert.deepEqual(
    calls,
    ['p1/a', 'p2/b', 'p2/b'],
    'the re-entry skips the cooling route and walks from the healthy head',
  )
  cleanup()
})

test('a re-entry after the cooldown expires tries the original head again', async () => {
  const clock = { now: 1_000_000 }
  const { adapter, calls, cleanup } = build(
    {
      'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] },
      'p2/b': { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] },
    },
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
    () => clock.now,
  )
  await walk(adapter, 'main')
  calls.length = 0

  clock.now += 60_000
  await walk(adapter, 'main')
  assert.deepEqual(calls, ['p1/a', 'p2/b'], 'the original head is retried once the cooldown expires')
  cleanup()
})

test('a terminal failure is not retried inside the same walk', async () => {
  const { adapter, calls, cleanup } = build(
    {
      'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } }] },
      'p2/b': { chunks: [{ type: 'text-delta', text: 'should not run' }, { type: 'finish', reason: { kind: 'stop' } }] },
    },
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }],
  )
  await walk(adapter, 'main')
  assert.deepEqual(calls, ['p1/a'], 'AUTH ends the walk; llm-retry owns what happens next')
  cleanup()
})
