// Drive the move bar the way a user does: select a row, then press ↓ repeatedly
// and check the selection follows the same model.
//
// This is the behaviour the user asked for — "I have to click the model again
// for every single move" — so it is asserted through real clicks rather than by
// calling the helper directly.
import assert from 'node:assert/strict'
import test from 'node:test'

import { mountCard } from './harness.js'

const ROUTES = [
  { provider: 'p1', model: 'a', note: 'first' },
  { provider: 'p1', model: 'b', note: 'second' },
  { provider: 'p2', model: 'c', note: 'third' },
]

const state = () => ({
  settings: { chains: [{ id: 'chain-1', name: '日常', enabled: true, routes: ROUTES }] },
  catalog: [
    { id: 'p1', name: 'P1', models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] },
    { id: 'p2', name: 'P2', models: [{ id: 'c', name: 'C' }] },
  ],
  diagnostics: {},
})

test('nothing is selected on mount and both arrows are disabled', async () => {
  const card = await mountCard(state())
  assert.deepEqual(card.selectedFlags(), [false, false, false])
  assert.equal(card.disabled('up'), true)
  assert.equal(card.disabled('down'), true)
})

test('selecting a row highlights exactly that row', async () => {
  const card = await mountCard(state())
  await card.select(1)
  assert.deepEqual(card.selectedFlags(), [false, true, false], 'only the clicked row is highlighted')
})

test('clicking a selected row again clears the selection', async () => {
  const card = await mountCard(state())
  await card.select(1)
  await card.select(1)
  assert.deepEqual(card.selectedFlags(), [false, false, false])
})

test('repeated ↓ presses walk the same model to the bottom', async () => {
  const card = await mountCard(state())
  assert.deepEqual(card.models(), ['a', 'b', 'c'])

  await card.select(0)
  await card.press('down')
  assert.deepEqual(card.models(), ['b', 'a', 'c'], 'the first press swaps a and b')
  assert.deepEqual(card.selectedFlags(), [false, true, false], 'the selection follows a')

  await card.press('down')
  assert.deepEqual(card.models(), ['b', 'c', 'a'], 'the second press moves the same model again')
  assert.deepEqual(card.selectedFlags(), [false, false, true], 'the selection still follows a')

  assert.equal(card.disabled('down'), true, 'the down arrow switches off at the bottom')
})

test('repeated ↑ presses walk the same model to the top', async () => {
  const card = await mountCard(state())
  await card.select(2)
  await card.press('up')
  assert.deepEqual(card.models(), ['a', 'c', 'b'])
  await card.press('up')
  assert.deepEqual(card.models(), ['c', 'a', 'b'], 'the same model keeps moving up')
  assert.equal(card.disabled('up'), true)
})

test('the bar names the position being adjusted', async () => {
  const card = await mountCard(state())
  await card.select(1)
  assert.match(card.barText(), /第 2 个/, 'the bar must say which item is selected')
  await card.press('down')
  assert.match(card.barText(), /第 3 个/, 'the position must follow the moved item')
})

test('clicking a dropdown inside a row does not change the selection', async () => {
  const card = await mountCard(state())
  await card.select(0)
  const row = card.routeRows()[0]
  row.props.onClick({ target: { tagName: 'SELECT' } })
  await card.settle()
  assert.deepEqual(card.selectedFlags(), [true, false, false], 'the selection must be unchanged')
})

test('clicking the ✕ does not select the row it removes', async () => {
  const card = await mountCard(state())
  const row = card.routeRows()[0]
  row.props.onClick({ target: { tagName: 'BUTTON' } })
  await card.settle()
  assert.deepEqual(card.selectedFlags(), [false, false, false], 'removing must not also select')
})

test('the note travels with its route when it moves', async () => {
  const card = await mountCard(state())
  await card.select(0)
  await card.press('down')
  assert.deepEqual(
    card.notes(),
    ['second', 'first', 'third'],
    'a note belongs to its model, so it must move with it',
  )
})

test('the provider and model stay paired when a route moves', async () => {
  const card = await mountCard(state())
  await card.select(2)
  await card.press('up')
  await card.press('up')
  // Route c (p2) must arrive at the top with its own provider still selected.
  const rows = card.routeRows()
  const first = rows[0]
  const selects = []
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node.type === 'select') selects.push(node.props.value)
    for (const child of node.children ?? []) walk(child)
  }
  walk(first)
  assert.deepEqual(selects, ['p2', 'c'], 'a route must move as one unit')
})
