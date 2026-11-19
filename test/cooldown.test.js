/**
 * Assertions for route cooldown.
 *
 * The property that matters: cooldown may reorder the chain but must never empty
 * it. A chain that refuses to attempt anything is worse than a slow one, so an
 * all-cooling chain is still walked in its configured order.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CooldownTable, BASE_COOLDOWN_MS, MAX_COOLDOWN_MS } from '../src/cooldown.js'
import { RotationAdapter } from '../src/adapter.js'
import { SettingsStore, ROUTER_PROVIDER } from '../src/config.js'

/** A controllable clock. */
function clock(start = 1_000_000) {
  let now = start
  return {
    now: () => now,
    advance: ms => {
      now += ms
    },
  }
}

const route = (provider, model) => ({ provider, model })

// ---------------------------------------------------------------------------
// CooldownTable
// ---------------------------------------------------------------------------

test('a fresh route is not cooling', () => {
  const table = new CooldownTable({ now: clock().now })
  assert.equal(table.isCooling(route('p', 'a')), false)
})

test('a failure starts a cooldown that expires on its own', () => {
  const c = clock()
  const table = new CooldownTable({ now: c.now })
  const held = table.fail(route('p', 'a'))
  assert.equal(held, BASE_COOLDOWN_MS)
  assert.equal(table.isCooling(route('p', 'a')), true)

  c.advance(BASE_COOLDOWN_MS - 1)
  assert.equal(table.isCooling(route('p', 'a')), true, 'still cooling just before expiry')

  c.advance(1)
  assert.equal(table.isCooling(route('p', 'a')), false, 'expires exactly at the deadline')
})

test('consecutive failures grow the cooldown exponentially up to a cap', () => {
  const c = clock()
  const table = new CooldownTable({ now: c.now })
  const held = []
  for (let i = 0; i < 8; i += 1) {
    held.push(table.fail(route('p', 'a')))
    c.advance(1)
  }
  assert.equal(held[0], BASE_COOLDOWN_MS)
  assert.equal(held[1], BASE_COOLDOWN_MS * 2)
  assert.equal(held[2], BASE_COOLDOWN_MS * 4)
  assert.equal(held.at(-1), MAX_COOLDOWN_MS, 'capped at the maximum')
})

test('a success clears the cooldown and the streak', () => {
  const c = clock()
  const table = new CooldownTable({ now: c.now })
  table.fail(route('p', 'a'))
  table.fail(route('p', 'a'))
  table.succeed(route('p', 'a'))
  assert.equal(table.isCooling(route('p', 'a')), false)

  // The next failure starts from the base again, not from streak 3.
  assert.equal(table.fail(route('p', 'a')), BASE_COOLDOWN_MS)
})

test('partition moves cooling routes to the back, keeping order', () => {
  const c = clock()
  const table = new CooldownTable({ now: c.now })
  const a = route('p1', 'a')
  const b = route('p2', 'b')
  const d = route('p3', 'd')
  table.fail(b)

  const { routes, cooling } = table.partition([a, b, d])
  assert.deepEqual(routes, [a, d, b], 'the cooling route moves last')
  assert.deepEqual(cooling, [b])
})

test('an all-cooling chain keeps its configured order', () => {
  const c = clock()
  const table = new CooldownTable({ now: c.now })
  const a = route('p1', 'a')
  const b = route('p2', 'b')
  table.fail(a)
  table.fail(b)

  const { routes, cooling } = table.partition([a, b])
  assert.deepEqual(routes, [a, b], 'the chain must still be walkable')
  assert.deepEqual(cooling, [], 'nothing is reported as held out when everything is')
})

test('a route is identified by provider and model, not by chain', () => {
  const c = clock()
  const table = new CooldownTable({ now: c.now })
  table.fail(route('p1', 'a'))
  // The same route reached through a different chain shares the state.
  assert.equal(table.isCooling(route('p1', 'a')), true)
  assert.equal(table.isCooling(route('p1', 'b')), false)
})

// ---------------------------------------------------------------------------
// adapter integration
// ---------------------------------------------------------------------------

/** Build an adapter whose routes answer as the test dictates. */
function build(routes, now = clock().now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-cool-'))
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

  const calls = []
  const cooldown = new CooldownTable({ now })
  const adapter = new RotationAdapter({ store, cooldown })
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
  return { adapter, cooldown, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

async function drain(adapter) {
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  const chunks = []
  for await (const chunk of prepared.stream({ messages: [] })) chunks.push(chunk)
  return chunks
}

const failRate = { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }] }
const okAnswer = { chunks: [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }] }

test('a failing route is skipped on the next request', async () => {
  const c = clock()
  const { adapter, calls, cleanup } = build({ 'p1/a': failRate, 'p2/b': okAnswer }, c.now)

  await drain(adapter)
  assert.deepEqual(calls, ['p1/a', 'p2/b'], 'first request tries both')

  calls.length = 0
  await drain(adapter)
  assert.deepEqual(calls, ['p2/b'], 'the cooling route is not retried')
  cleanup()
})

test('the cooldown expires and the route is tried again', async () => {
  const c = clock()
  const { adapter, calls, cleanup } = build({ 'p1/a': failRate, 'p2/b': okAnswer }, c.now)

  await drain(adapter)
  calls.length = 0

  c.advance(BASE_COOLDOWN_MS + 1)
  await drain(adapter)
  assert.deepEqual(calls, ['p1/a', 'p2/b'], 'the route is retried after expiry')
  cleanup()
})

test('a success clears the cooldown so the next request starts at the head', async () => {
  const c = clock()
  let failFirst = true
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-cool-'))
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  store.write({ chains: [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }, { provider: 'p2', model: 'b' }] }] })
  const calls = []
  const adapter = new RotationAdapter({ store, cooldown: new CooldownTable({ now: c.now }) })
  adapter.ctx = {
    llm: {
      async prepareCall(config) {
        const key = config.provider + '/' + config.model
        calls.push(key)
        const failing = key === 'p1/a' && failFirst
        return {
          config: { provider: config.provider, model: config.model },
          stream: () =>
            (async function* () {
              if (failing) {
                yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }
                return
              }
              yield { type: 'text-delta', text: 'ok' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })(),
        }
      },
      async resolveModelInfo() {
        return { context: { contextWindow: 200000 }, inputModalities: ['text'] }
      },
    },
  }

  await drain(adapter)
  assert.deepEqual(calls, ['p1/a', 'p2/b'])

  // p1 is healthy now, but still cooling: the next request skips it.
  failFirst = false
  calls.length = 0
  await drain(adapter)
  assert.deepEqual(calls, ['p2/b'], 'still cooling')

  // Once the cooldown expires and p1 answers, the streak clears.
  c.advance(BASE_COOLDOWN_MS + 1)
  calls.length = 0
  await drain(adapter)
  assert.deepEqual(calls, ['p1/a'], 'the head is used again')
  assert.equal(adapter.cooldown.isCooling({ provider: 'p1', model: 'a' }), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a terminal failure does not start a cooldown', async () => {
  const c = clock()
  const { adapter, calls, cleanup } = build(
    {
      'p1/a': { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } }] },
      'p2/b': okAnswer,
    },
    c.now,
  )

  await drain(adapter)
  assert.deepEqual(calls, ['p1/a'], 'AUTH does not fall over')
  assert.equal(
    adapter.cooldown.isCooling({ provider: 'p1', model: 'a' }),
    false,
    'a terminal failure must not hide the route',
  )
  cleanup()
})

test('a user abort does not start a cooldown', async () => {
  const c = clock()
  const controller = new AbortController()
  const { adapter, cleanup } = build(
    {
      'p1/a': { chunks: [{ type: 'text-delta', text: 'a' }, { type: 'text-delta', text: 'b' }] },
    },
    c.now,
  )
  const prepared = await adapter.prepareCall(ROUTER_PROVIDER, 'main')
  for await (const _chunk of prepared.stream({ messages: [], signal: controller.signal })) {
    controller.abort()
  }
  assert.equal(adapter.cooldown.isCooling({ provider: 'p1', model: 'a' }), false)
  cleanup()
})

test('an all-cooling chain is still walked rather than failing outright', async () => {
  const c = clock()
  const { adapter, calls, cleanup } = build({ 'p1/a': failRate, 'p2/b': failRate }, c.now)

  await drain(adapter)
  // Both routes are cooling now.
  assert.equal(adapter.cooldown.isCooling({ provider: 'p1', model: 'a' }), true)
  assert.equal(adapter.cooldown.isCooling({ provider: 'p2', model: 'b' }), true)

  calls.length = 0
  const chunks = await drain(adapter)
  assert.deepEqual(calls, ['p1/a', 'p2/b'], 'the chain must still be attempted in order')
  assert.equal(chunks.at(-1).reason.kind, 'error', 'and still report the real failure')
  cleanup()
})
