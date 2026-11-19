/**
 * Assertions for the metadata cache.
 *
 * Two properties matter:
 *   1. the cache must not grow with the number of requests (it is keyed by route);
 *   2. a route removed from every chain must lose its cached capabilities, or a
 *      re-added route would be routed using its old context window.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RotationAdapter } from '../src/adapter.js'
import { SettingsStore, ROUTER_PROVIDER } from '../src/config.js'

/** Build an adapter that records every metadata lookup. */
function build(initialChains, infoFor = () => ({ context: { contextWindow: 200000 }, inputModalities: ['text'] })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-cache-'))
  const store = new SettingsStore(path.join(dir, 'settings.json'))
  store.write({ chains: initialChains })
  const queries = []
  const adapter = new RotationAdapter({ store })
  adapter.ctx = {
    llm: {
      async prepareCall() {
        throw Object.assign(new Error('unused'), { code: 'NO_ADAPTER' })
      },
      async resolveModelInfo(provider, model) {
        queries.push(provider + '/' + model)
        return infoFor(provider, model)
      },
    },
  }
  return { adapter, store, queries, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('a repeated resolve reuses the cached metadata', async () => {
  const { adapter, queries, cleanup } = build([
    { id: 'main', routes: [{ provider: 'p1', model: 'a' }] },
  ])
  await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  const afterFirst = queries.length
  await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.equal(queries.length, afterFirst, 'the second resolve must hit the cache')
  cleanup()
})

test('the cache does not grow with the number of requests', async () => {
  const { adapter, queries, cleanup } = build([
    { id: 'main', routes: [{ provider: 'p1', model: 'a' }] },
  ])
  for (let i = 0; i < 20; i += 1) await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.equal(queries.length, 1, 'twenty resolves of one route must query once')
  cleanup()
})

test('removing a route drops its cached capabilities', async () => {
  // The first lookup reports a small window; the second reports a large one.
  // Without pruning, re-adding the route would keep the small window.
  let call = 0
  const { adapter, store, queries, cleanup } = build(
    [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }] }],
    () => {
      call += 1
      return { context: { contextWindow: call === 1 ? 1000 : 1000000 }, inputModalities: ['text'] }
    },
  )

  const first = await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.equal(first.context.contextWindow, 1000)

  // Remove the route entirely, then add it back.
  store.write({ chains: [{ id: 'main', routes: [] }] })
  await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  store.write({ chains: [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }] }] })

  const second = await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.equal(second.context.contextWindow, 1000000, 'the re-added route must be re-queried')
  assert.ok(queries.length >= 2, 'queries=' + queries.length)
  cleanup()
})

test('a route still present in another chain keeps its cache', async () => {
  const { adapter, store, queries, cleanup } = build([
    { id: 'one', routes: [{ provider: 'p1', model: 'a' }] },
    { id: 'two', routes: [{ provider: 'p1', model: 'a' }] },
  ])

  await adapter.resolveModel(ROUTER_PROVIDER, 'one')
  const afterFirst = queries.length

  // Remove chain "one" but keep chain "two" holding the same route.
  store.write({ chains: [{ id: 'two', routes: [{ provider: 'p1', model: 'a' }] }] })
  await adapter.resolveModel(ROUTER_PROVIDER, 'two')

  assert.equal(queries.length, afterFirst, 'a route still configured must not be re-queried')
  cleanup()
})

test('a failed lookup is cached as unknown and retried after the TTL', async () => {
  // An unknown capability must not be treated as a rejection forever; the TTL is
  // what lets a transient failure recover.
  let calls = 0
  const { adapter, store, cleanup } = build([{ id: 'main', routes: [{ provider: 'p1', model: 'a' }] }], () => {
    calls += 1
    throw new Error('transient')
  })

  const info = await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  // No context is reported, so the chain advertises no window rather than zero.
  assert.equal(info.context, undefined)
  assert.equal(calls, 1)

  // A second resolve inside the TTL must not re-query.
  await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.equal(calls, 1, 'the failure is cached for the TTL')

  // Re-adding the route prunes the entry, so the next resolve retries.
  store.write({ chains: [{ id: 'main', routes: [] }] })
  await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  store.write({ chains: [{ id: 'main', routes: [{ provider: 'p1', model: 'a' }] }] })
  await adapter.resolveModel(ROUTER_PROVIDER, 'main')
  assert.equal(calls, 2, 'a pruned route is retried')
  cleanup()
})
