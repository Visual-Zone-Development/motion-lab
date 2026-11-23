// The safety gate (safety.js): a round with a phone holds on "Before you move" until that phone
// has read the card, or this machine skips it after a moment. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSafetyGate } from '../safety.js'

const DT = 1 / 60
const frames = (gate, n, opts) => {
  let open = false
  for (let i = 0; i < n && !open; i++) open = gate.update(DT, opts)
  return open
}

test('a round with a phone that has not read the card is held until I’m ready', () => {
  const gate = createSafetyGate({ min: 2.5 })
  assert.equal(gate.hold('ada'), true)
  assert.equal(frames(gate, 60, { phone: 'ada' }), false)
  gate.read('ada')
  assert.equal(gate.update(DT, { phone: 'ada' }), true)
  assert.equal(gate.held, false)
})

test('once read, the next rounds with that phone start straight away', () => {
  const gate = createSafetyGate()
  gate.read('ada')
  assert.equal(gate.hold('ada'), false)
})

test('a round with no phone (controller, keyboard, touch) is never held', () => {
  assert.equal(createSafetyGate().hold(null), false)
})

test('this machine can skip it, but only after it has been up long enough to be read', () => {
  const gate = createSafetyGate({ min: 2.5 })
  gate.hold('ada')
  assert.equal(gate.update(DT, { phone: 'ada', skip: true }), false, 'skipped at once')
  assert.equal(gate.canSkip, false)
  frames(gate, 160, { phone: 'ada' })
  assert.equal(gate.canSkip, true)
  assert.equal(gate.update(DT, { phone: 'ada', skip: true }), true)
})

test('another phone taking over has to read it too; the phone dropping out lets the round go', () => {
  const gate = createSafetyGate()
  gate.hold('ada')
  gate.read('ada')
  gate.hold('ada')
  gate.hold('bo')
  assert.equal(gate.update(DT, { phone: 'bo' }), false)
  assert.equal(gate.update(DT, { phone: null }), true)
})
