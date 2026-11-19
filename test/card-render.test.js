// Render the settings card and assert the layout the user asked for:
//   - the note sits on the same line as the ✕
//   - the chain enable control is a switch
//   - move arrows live in a bar, not in each row
//
// See harness.js for why the mini React must honour dependency arrays: without
// that, the mount effect re-runs on every render, re-fetches, and overwrites the
// draft — making a working card look frozen.
import assert from 'node:assert/strict'
import test from 'node:test'

import { findAll, flatten, mountCard, textOf } from './harness.js'

const ROUTES = [
  { provider: 'p1', model: 'a', note: '便宜' },
  { provider: 'p2', model: 'b' },
]

const state = () => ({
  settings: { chains: [{ id: 'chain-1', name: '日常', enabled: true, routes: ROUTES }] },
  catalog: [
    { id: 'p1', name: 'P1', models: [{ id: 'a', name: 'A' }] },
    { id: 'p2', name: 'P2', models: [{ id: 'b', name: 'B' }] },
  ],
  diagnostics: {},
})

const NOTE_INPUT = node => node.type === 'input' && String(node.props.placeholder ?? '').includes('备注')
const ROUTE_ROW = node => node.type === 'div' && String(node.props.className ?? '') === 'dshMr-route'
const ROW = node => node.type === 'div' && String(node.props.className ?? '') === 'dshMr-row'

test('the card renders one note input per route', async () => {
  const card = await mountCard(state())
  assert.equal(findAll(card.tree(), NOTE_INPUT).length, 2)
})

test('a stored note is shown and a missing one starts empty', async () => {
  const card = await mountCard(state())
  assert.deepEqual(card.notes(), ['便宜', ''])
})

test('the note input is bounded and labelled', async () => {
  const card = await mountCard(state())
  const input = findAll(card.tree(), NOTE_INPUT)[0]
  assert.equal(input.props.maxLength, 200, 'the input must cap length, matching the server')
  assert.match(input.props.placeholder, /不会发给模型/, 'the label must say the note stays local')
})

test('every note input is controlled', async () => {
  const card = await mountCard(state())
  for (const input of findAll(card.tree(), NOTE_INPUT)) {
    assert.equal(typeof input.props.onChange, 'function', 'an uncontrolled note box would discard keystrokes')
  }
})

test('the note sits on the same line as the remove button', async () => {
  // Requested explicitly: the note should be beside the ✕ rather than on its own
  // line below the selectors.
  const card = await mountCard(state())
  const rows = findAll(card.tree(), ROW)
  const withBoth = rows.filter(row => {
    const children = flatten(row.children ?? [])
    return (
      children.some(NOTE_INPUT) &&
      children.some(child => child.type === 'button' && String(child.children?.[0] ?? '') === '✕')
    )
  })
  assert.equal(withBoth.length, 2, 'each route row must hold both the note and the ✕')
})

test('the note comes before the remove button in reading order', async () => {
  const card = await mountCard(state())
  const row = findAll(card.tree(), ROW).find(candidate => flatten(candidate.children ?? []).some(NOTE_INPUT))
  const children = flatten(row.children ?? [])
  const noteIndex = children.findIndex(NOTE_INPUT)
  const removeIndex = children.findIndex(
    child => child.type === 'button' && String(child.children?.[0] ?? '') === '✕',
  )
  assert.ok(noteIndex >= 0 && removeIndex >= 0)
  assert.ok(noteIndex < removeIndex, 'the note must precede the ✕')
})

test('the chain enable control is a switch, not a bare checkbox', async () => {
  const card = await mountCard(state())
  const switches = findAll(card.tree(), node => node.type === 'label' && node.props.className === 'dshMr-switch')
  assert.equal(switches.length, 1, 'one chain means one switch')
  const inner = flatten(switches[0].children ?? [])
  assert.ok(
    inner.some(node => node.type === 'input' && node.props.type === 'checkbox'),
    'the switch must keep a real checkbox for keyboard and screen readers',
  )
  assert.ok(
    inner.some(node => String(node.props.className ?? '').includes('switch-track')),
    'the switch must draw a track',
  )
})

test('the switch reflects and patches the enabled flag', async () => {
  const card = await mountCard(state())
  const checkbox = findAll(card.tree(), node => node.type === 'input' && node.props.type === 'checkbox')[0]
  assert.equal(checkbox.props.checked, true)
  assert.equal(typeof checkbox.props.onChange, 'function', 'toggling must be wired')
  // Dispatching must not throw.
  checkbox.props.onChange({ target: { checked: false } })
})

test('a route row carries no arrows of its own', async () => {
  // Arrows inside the row reflowed the list under the cursor, which is what made
  // repeated moves hard to follow.
  const card = await mountCard(state())
  for (const row of findAll(card.tree(), ROUTE_ROW)) {
    const arrows = flatten(row.children ?? []).filter(
      node => node.type === 'button' && ['↑', '↓'].includes(String(node.children?.[0] ?? '')),
    )
    assert.equal(arrows.length, 0, 'a route row must not carry its own arrows')
  }
})

test('the move bar holds both arrows', async () => {
  const card = await mountCard(state())
  const labels = card.barButtons().map(button => String(button.children?.[0] ?? ''))
  assert.deepEqual(labels, ['↑', '↓'])
})

test('the move bar explains what to do before anything is selected', async () => {
  const card = await mountCard(state())
  assert.match(card.barText(), /点一行选中/, 'the bar must say a row has to be selected first')
  for (const button of card.barButtons()) {
    assert.equal(button.props.disabled, true, 'moving is impossible before a selection')
  }
})

test('a chain with one route shows no move bar', async () => {
  const single = {
    settings: { chains: [{ id: 'solo', name: '兜底', enabled: true, routes: [{ provider: 'p1', model: 'a' }] }] },
    catalog: [{ id: 'p1', name: 'P1', models: [{ id: 'a', name: 'A' }] }],
    diagnostics: {},
  }
  const card = await mountCard(single)
  assert.equal(card.moveBar(), undefined, 'a single-route chain needs no move bar')
})

test('a disabled chain still renders its switch as off', async () => {
  const off = {
    settings: { chains: [{ id: 'chain-1', name: '日常', enabled: false, routes: ROUTES }] },
    catalog: [
      { id: 'p1', name: 'P1', models: [{ id: 'a', name: 'A' }] },
      { id: 'p2', name: 'P2', models: [{ id: 'b', name: 'B' }] },
    ],
    diagnostics: {},
  }
  const card = await mountCard(off)
  const checkbox = findAll(card.tree(), node => node.type === 'input' && node.props.type === 'checkbox')[0]
  assert.equal(checkbox.props.checked, false)
  assert.match(textOf(findAll(card.tree(), node => node.props.className === 'dshMr-switch')[0]), /已停用/)
})
