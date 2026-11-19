/**
 * Offline assertions for the settings card's pure helpers.
 *
 * The card is a browser artifact, so this loads it with a stubbed module table
 * and checks the logic that can silently corrupt a saved chain: cloning, moving,
 * and id generation.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'client.js')

/** Minimal React stand-in: elements are plain objects. */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    memo: c => c,
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useId: () => 'id',
    useRef: () => ({ current: [] }),
  }
}

/** Load the browser artifact and return its factory result. */
function loadPlugin() {
  const source = fs.readFileSync(CLIENT, 'utf8')
  let captured
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          captured = factory
        },
      },
    },
    document: undefined,
    console,
    fetch: () => Promise.reject(new Error('no network in this test')),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.equal(typeof captured, 'function', 'client.js must register a factory')
  return captured(name => {
    if (name === 'react') return fakeReact()
    if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    throw new Error('unexpected require: ' + name)
  })
}

test('the card registers into the plugin settings tab slot', () => {
  const plugin = loadPlugin()
  const registered = []
  const ctx = {
    get: () => null,
    effect: () => () => {},
    slots: {
      inject: (slot, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  assert.equal(registered.length, 1)
  // `settings.plugins.tab` is the child list `PluginsSettingsSection` declares and
  // reads with `ctx.slots.entries(...)`; it is what becomes the tab strip. The
  // shell's own `plugins.item` slot is a different surface entirely.
  assert.equal(registered[0].options.name, 'settings.plugins.tab')
  // A list slot is addressed by `id`, and the section renders `label`.
  assert.equal(registered[0].options.id, 'model-rotation')
  assert.equal(typeof registered[0].options.label, 'function')
  assert.equal(registered[0].options.key, undefined, 'a list slot must not be given a key')
})

// The artifact runs inside a vm context, so its objects carry that realm's
// Object.prototype and `deepStrictEqual` rejects them on identity. Comparing
// through JSON asserts the same shape without the realm mismatch.
const sameJson = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected))

test('cloneSettings deep-copies so the draft never aliases the server state', () => {
  const plugin = loadPlugin()
  const source = {
    chains: [{ id: 'a', name: 'A', enabled: true, routes: [{ provider: 'p', model: 'm' }] }],
  }
  const copy = plugin.__test.cloneSettings(source)
  // The draft normalizes a missing note to the empty string so the note input is
  // controlled from the first render.
  sameJson(copy, {
    chains: [{ id: 'a', name: 'A', enabled: true, routes: [{ provider: 'p', model: 'm', note: '' }] }],
  })
  copy.chains[0].name = 'changed'
  copy.chains[0].routes[0].model = 'changed'
  assert.equal(source.chains[0].name, 'A', 'the source must not be mutated')
  assert.equal(source.chains[0].routes[0].model, 'm')
})

test('cloneSettings keeps a route note', () => {
  const plugin = loadPlugin()
  const copy = plugin.__test.cloneSettings({
    chains: [{ id: 'a', name: 'A', routes: [{ provider: 'p', model: 'm', note: '强推理' }] }],
  })
  assert.equal(copy.chains[0].routes[0].note, '强推理')
})

test('cloneSettings does not alias the note either', () => {
  const plugin = loadPlugin()
  const source = {
    chains: [{ id: 'a', name: 'A', routes: [{ provider: 'p', model: 'm', note: 'original' }] }],
  }
  const copy = plugin.__test.cloneSettings(source)
  copy.chains[0].routes[0].note = 'changed'
  assert.equal(source.chains[0].routes[0].note, 'original', 'the note must be copied, not shared')
})

test('cloneSettings tolerates a non-string note', () => {
  const plugin = loadPlugin()
  const copy = plugin.__test.cloneSettings({
    chains: [{ id: 'a', name: 'A', routes: [{ provider: 'p', model: 'm', note: 42 }] }],
  })
  assert.equal(copy.chains[0].routes[0].note, '', 'a malformed note must not crash the card')
})

test('cloneSettings treats a missing enabled flag as enabled', () => {
  const plugin = loadPlugin()
  const copy = plugin.__test.cloneSettings({ chains: [{ id: 'a', name: 'A', routes: [] }] })
  assert.equal(copy.chains[0].enabled, true)
})

test('cloneSettings survives an empty or missing document', () => {
  const plugin = loadPlugin()
  sameJson(plugin.__test.cloneSettings(undefined), { chains: [] })
  sameJson(plugin.__test.cloneSettings({}), { chains: [] })
})

test('moved reorders without mutating the input', () => {
  const plugin = loadPlugin()
  const list = ['a', 'b', 'c']
  assert.equal(JSON.stringify(plugin.__test.moved(list, 0, 2)), JSON.stringify(['b', 'c', 'a']))
  assert.equal(JSON.stringify(list), JSON.stringify(['a', 'b', 'c']), 'the input must not be mutated')
})

test('moved refuses an out-of-range target', () => {
  const plugin = loadPlugin()
  const list = ['a', 'b']
  assert.equal(plugin.__test.moved(list, 0, -1), list)
  assert.equal(plugin.__test.moved(list, 0, 2), list)
})

test('newChainId avoids ids already in use', () => {
  const plugin = loadPlugin()
  assert.equal(plugin.__test.newChainId([]), 'chain-1')
  assert.equal(plugin.__test.newChainId([{ id: 'chain-1' }]), 'chain-2')
  assert.equal(plugin.__test.newChainId([{ id: 'chain-1' }, { id: 'chain-2' }, { id: 'chain-3' }]), 'chain-4')
})

test('step moves one place and reports the new index', () => {
  // The move bar acts on a selection, so it must return where the moved item
  // ended up; a caller that kept the old index would start moving its neighbour.
  const plugin = loadPlugin()
  const list = ['a', 'b', 'c']
  assert.equal(JSON.stringify(plugin.__test.step(list, 0, 1)), JSON.stringify({ list: ['b', 'a', 'c'], index: 1 }))
  assert.equal(JSON.stringify(plugin.__test.step(list, 2, -1)), JSON.stringify({ list: ['a', 'c', 'b'], index: 1 }))
})

test('step refuses to move past either end', () => {
  const plugin = loadPlugin()
  const list = ['a', 'b', 'c']
  // Moving the first item up must be a no-op that keeps the index, so repeated
  // presses at the boundary cannot shuffle anything.
  assert.equal(JSON.stringify(plugin.__test.step(list, 0, -1)), JSON.stringify({ list, index: 0 }))
  assert.equal(JSON.stringify(plugin.__test.step(list, 2, 1)), JSON.stringify({ list, index: 2 }))
})

test('step does not mutate the input list', () => {
  const plugin = loadPlugin()
  const list = ['a', 'b', 'c']
  plugin.__test.step(list, 0, 1)
  assert.equal(JSON.stringify(list), JSON.stringify(['a', 'b', 'c']))
})

test('step survives an out-of-range index', () => {
  const plugin = loadPlugin()
  const list = ['a']
  assert.equal(JSON.stringify(plugin.__test.step(list, 5, 1)), JSON.stringify({ list, index: 5 }))
})

test('repeated step calls walk one item to the end', () => {
  // This is the behaviour the user asked for: press the arrow again and again
  // instead of clicking a row each time.
  const plugin = loadPlugin()
  let list = ['a', 'b', 'c', 'd']
  let index = 0
  for (let press = 0; press < 3; press += 1) {
    const result = plugin.__test.step(list, index, 1)
    list = result.list
    index = result.index
  }
  assert.equal(JSON.stringify(list), JSON.stringify(['b', 'c', 'd', 'a']))
  assert.equal(index, 3, 'the selection must follow the item to the end')
})
