// A mini React that honours dependency arrays, shared by the interaction tests.
//
// Why the deps matter here: the card runs `useEffect(() => void refresh(), [refresh])`
// and `refresh = useCallback(..., [])`. In real React `refresh` is stable, so the
// effect runs once. A naive stub that returns a fresh function from `useCallback`
// and re-runs every effect on every render instead re-fetches and overwrites the
// draft after each interaction — which makes a working move bar look broken.
//
// This harness therefore implements the two rules that matter:
//   - `useCallback(fn, deps)` returns the same function while deps are unchanged
//   - `useEffect(fn, deps)` runs only when deps change (or on first render)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/** Compare two dependency arrays the way React does (shallow, Object.is). */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * Build a mini React with React's deps semantics.
 * @returns {object} the runtime, with test hooks prefixed `__`.
 */
export function miniReact() {
  const stateSlots = []
  const callbackSlots = []
  const effectSlots = []
  let cursor = 0
  let rerender = null
  let dirty = false

  const runtime = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    memo: component => component,

    useState(initial) {
      const index = cursor++
      if (!(index in stateSlots)) stateSlots[index] = typeof initial === 'function' ? initial() : initial
      const set = value => {
        const next = typeof value === 'function' ? value(stateSlots[index]) : value
        if (Object.is(next, stateSlots[index])) return
        stateSlots[index] = next
        dirty = true
        rerender?.()
      }
      return [stateSlots[index], set]
    },

    useCallback(fn, deps) {
      const index = cursor++
      const slot = callbackSlots[index]
      if (slot === undefined || !sameDeps(slot.deps, deps)) {
        callbackSlots[index] = { fn, deps }
        return fn
      }
      return slot.fn
    },

    useEffect(effect, deps) {
      const index = cursor++
      const slot = effectSlots[index]
      // No deps means "every render", matching React.
      if (slot === undefined || deps === undefined || !sameDeps(slot.deps, deps)) {
        effectSlots[index] = { effect, deps }
        runtime.__pending.push(effect)
      }
    },

    useId: () => 'id',
    useRef: () => ({ current: [] }),

    __pending: [],

    /** Reset the per-render hook cursor; collect effects that must now run. */
    __begin() {
      cursor = 0
      dirty = false
    },

    /** Effects scheduled during the last render. */
    __effects() {
      const list = runtime.__pending.slice()
      runtime.__pending.length = 0
      return list
    },

    __setRerender(fn) {
      rerender = fn
    },

    __dirty() {
      return dirty
    },
  }
  return runtime
}

/** Flatten an element tree into a list of nodes. */
export function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}

/** Find every node matching a predicate. */
export function findAll(tree, predicate) {
  return flatten(tree).filter(predicate)
}

/**
 * Concatenate every string found anywhere under a node.
 *
 * Text in this card is nested inside spans, so reading only direct children
 * returns '' and makes a correct label look missing.
 * @param {object} node - element to read.
 * @returns {string} all descendant text.
 */
export function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

/**
 * Load the client artifact and mount its card.
 *
 * The `fetch` stub lives inside the vm realm: the card calls the bare `fetch`
 * identifier, which resolves in its own context, not the outer one.
 * @param {object} state - the `/state` payload the card should see.
 * @returns {Promise<object>} helpers to render, click and inspect.
 */
export async function mountCard(state) {
  const react = miniReact()
  const source = fs.readFileSync(CLIENT, 'utf8')
  let captured
  const sandbox = {
    window: { __ModuleLoader__: { load({ factory }) { captured = factory } } },
    document: undefined,
    console,
    fetch: async url => {
      if (String(url).endsWith('/state')) return { ok: true, json: async () => state, text: async () => '' }
      return { ok: true, json: async () => ({ settings: state.settings }), text: async () => '' }
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const plugin = captured(name => {
    if (name === 'react') return react
    if (name === 'jsx-runtime') return { jsx: () => null, jsxs: () => null }
    throw new Error('unexpected require: ' + name)
  })

  const registered = []
  plugin.apply({
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
  })
  assert.equal(registered.length, 1, 'the card must register into the tab slot')
  const Card = registered[0].component

  let tree = null
  let renders = 0
  const render = () => {
    react.__begin()
    tree = Card({})
    renders += 1
  }
  react.__setRerender(() => {
    if (react.__dirty()) render()
  })

  /** Let queued effects and their promises settle, re-rendering as needed. */
  const settle = async () => {
    for (let pass = 0; pass < 6; pass += 1) {
      const effects = react.__effects()
      for (const effect of effects) effect()
      await new Promise(resolve => setTimeout(resolve, 5))
      if (effects.length > 0) render()
    }
  }

  render()
  await settle()

  return {
    tree: () => tree,
    render,
    settle,
    routeRows: () =>
      findAll(tree, node => node.type === 'div' && String(node.props.className ?? '') === 'dshMr-route'),
    moveBar: () =>
      findAll(tree, node => node.type === 'div' && String(node.props.className ?? '').includes('dshMr-move'))[0],
    barButtons: () => flatten((findAll(tree, node => node.type === 'div' && String(node.props.className ?? '').includes('dshMr-move'))[0]).children ?? []).filter(node => node.type === 'button'),
    models: () =>
      findAll(tree, node => node.type === 'div' && String(node.props.className ?? '') === 'dshMr-route').map(row => {
        const selects = flatten(row.children ?? []).filter(node => node.type === 'select')
        return selects[1]?.props?.value ?? '?'
      }),
    notes: () =>
      findAll(tree, node => node.type === 'div' && String(node.props.className ?? '') === 'dshMr-route').map(row => {
        const input = flatten(row.children ?? []).find(
          node => node.type === 'input' && String(node.props.className ?? '').includes('dshMr-note'),
        )
        return input?.props?.value
      }),
    selectedFlags: () =>
      findAll(tree, node => node.type === 'div' && String(node.props.className ?? '') === 'dshMr-route').map(
        row => row.props['data-selected'],
      ),
    /** Click a row's background to toggle its selection. */
    select: async index => {
      const rows = findAll(tree, node => node.type === 'div' && String(node.props.className ?? '') === 'dshMr-route')
      rows[index].props.onClick({ target: { tagName: 'DIV' } })
      await settle()
    },
    /** Press ↑ (direction -1) or ↓ (direction +1). */
    press: async direction => {
      const bar = findAll(tree, node => node.type === 'div' && String(node.props.className ?? '').includes('dshMr-move'))[0]
      const buttons = flatten(bar.children ?? []).filter(node => node.type === 'button')
      const button = direction === 'up' ? buttons[0] : buttons[1]
      assert.equal(button.props.disabled, false, 'the ' + direction + ' arrow must be enabled for this press')
      button.props.onClick()
      await settle()
    },
    disabled: direction => {
      const bar = findAll(tree, node => node.type === 'div' && String(node.props.className ?? '').includes('dshMr-move'))[0]
      const buttons = flatten(bar.children ?? []).filter(node => node.type === 'button')
      return (direction === 'up' ? buttons[0] : buttons[1]).props.disabled
    },
    barText: () => {
      const bar = findAll(tree, node => node.type === 'div' && String(node.props.className ?? '').includes('dshMr-move'))[0]
      return textOf(bar)
    },
  }
}
