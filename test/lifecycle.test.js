/**
 * Verify plugin mount/unmount lifecycle.
 *
 * A rotation plugin that leaks its adapter registration or its slot entry would
 * break the picker after a reload. This drives `apply()` against a fake Cordis
 * context that records effects and disposers, then asserts everything is
 * released.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const BASE = 'file:///D:/Deeseek_HARENSS/创建插件/dsh-model-rotation'
const { apply, ROUTER_PROVIDER } = await import(BASE + '/index.js')

/** A fake Cordis context that records what the plugin registers. */
function fakeContext() {
  const effects = []
  const adapters = []
  const configurable = []
  const announcements = []
  let disposed = false

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect(factory, label) {
      const disposer = factory()
      effects.push({ label, disposer })
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject(_services, callback) {
      // The web surface is optional; record that the plugin asked for it.
      ctx.injectedWeb = true
      void callback
    },
    llm: {
      registerAdapter(providers, adapter) {
        adapters.push({ providers: [...providers], adapter })
        return () => {
          adapters.pop()
        }
      },
      registerConfigurableProviders(entries) {
        configurable.push(...entries)
      },
      emitAdaptersUpdated() {
        announcements.push(Date.now())
      },
      listProviders() {
        return [{ id: 'p1', name: 'P1' }]
      },
      async listModels() {
        return [{ id: 'm1', name: 'M1' }]
      },
    },
  }
  return {
    ctx,
    adapters,
    configurable,
    announcements,
    effects,
    isDisposed: () => disposed,
  }
}

test('apply registers exactly one adapter route for the plugin provider', () => {
  const fake = fakeContext()
  apply(fake.ctx)
  assert.equal(fake.adapters.length, 1)
  assert.deepEqual(fake.adapters[0].providers, [ROUTER_PROVIDER])
  assert.equal(typeof fake.adapters[0].adapter.prepareCall, 'function')
})

test('apply installs effects for the adapter route and settings watch', () => {
  const fake = fakeContext()
  apply(fake.ctx)
  const labels = fake.effects.map(effect => effect.label)
  assert.ok(labels.some(label => label.includes('adapter route')), labels.join(' | '))
  assert.ok(labels.some(label => label.includes('catalog notifications')), labels.join(' | '))
  assert.ok(labels.some(label => label.includes('settings watch')), labels.join(' | '))
})

test('every effect disposes cleanly', () => {
  const fake = fakeContext()
  apply(fake.ctx)
  for (const effect of fake.effects) {
    assert.equal(typeof effect.disposer, 'function', effect.label + ' must return a disposer')
    effect.disposer()
  }
  // Disposing the adapter route removes the registration.
  assert.equal(fake.adapters.length, 0, 'the adapter route must be unregistered on dispose')
})

test('the settings watch timer is cleared on dispose', async () => {
  const fake = fakeContext()
  apply(fake.ctx)
  const watch = fake.effects.find(effect => effect.label.includes('settings watch'))
  assert.ok(watch, 'a settings watch must exist')
  // Disposing must not throw and must stop the timer; a leaked interval would
  // keep the process alive, which the test runner would surface as a hang.
  watch.disposer()
})

test('mounting twice then unmounting leaves no registration', () => {
  const fake = fakeContext()
  apply(fake.ctx)
  const first = fake.effects.filter(e => e.label.includes('adapter route'))
  apply(fake.ctx)
  const all = fake.effects.filter(e => e.label.includes('adapter route'))
  assert.equal(all.length, 2, 'each apply registers its own route')
  for (const effect of first) effect.disposer()
  for (const effect of all.slice(1)) effect.disposer()
  assert.equal(fake.adapters.length, 0, 'all registrations must be released')
})

test('a kernel without registerConfigurableProviders still mounts', () => {
  const fake = fakeContext()
  fake.ctx.llm.registerConfigurableProviders = undefined
  // Must not throw: the capability is optional on older kernel lines.
  apply(fake.ctx)
  assert.equal(fake.adapters.length, 1)
})

test('a throwing registerConfigurableProviders does not break routing', () => {
  const fake = fakeContext()
  fake.ctx.llm.registerConfigurableProviders = () => {
    throw new Error('directory rejected the entry')
  }
  apply(fake.ctx)
  assert.equal(fake.adapters.length, 1, 'the adapter must stay registered')
})

test('a reload produces a fresh adapter, not a shared one', () => {
  // The in-flight counter lives inside `apply()`, so a reload must build a new
  // adapter with its own counter. A shared instance would double-count every
  // request after the reload.
  const first = fakeContext()
  apply(first.ctx)
  const firstAdapter = first.adapters[0].adapter
  for (const effect of first.effects) {
    if (typeof effect.disposer === 'function') effect.disposer()
  }

  const second = fakeContext()
  apply(second.ctx)
  const secondAdapter = second.adapters[0].adapter

  assert.notEqual(firstAdapter, secondAdapter, 'a reload must not reuse the adapter instance')
  assert.equal(first.adapters.length, 0, 'the first mount must be fully unregistered')
  assert.equal(second.adapters.length, 1)
})

test('two concurrent mounts keep separate counters', () => {
  // If the host ever mounts twice without disposing, each adapter must still own
  // its own diagnostics rather than sharing one.
  const first = fakeContext()
  const second = fakeContext()
  apply(first.ctx)
  apply(second.ctx)
  assert.notEqual(first.adapters[0].adapter, second.adapters[0].adapter)
  assert.equal(first.adapters.length, 1, 'each context holds its own registration')
  assert.equal(second.adapters.length, 1)
})
