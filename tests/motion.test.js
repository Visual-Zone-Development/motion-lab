// The TV side of the phone link (createMotion): what a station reads from the phone's held input.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMotion } from '../motion.js'

const TUNING = {
  motion: { tiltRange: 25, defaultBeta: 35, swingThresholds: [8, 12, 17], padPower: 0.8, swipeMin: 70, swipeFull: 2600, pingEvery: 1, filterMin: 1.6, filterBeta: 0.6, wheelRange: 70, wheelFilter: 2.2, gyroSpread: 0.03, centerWait: 1.5, clockSamples: 8, fullSwing: 32, dirDeadzone: 2, peakMs: 110, flipWindowMs: 260, gyroSwingK: 1 / 30, gyroTighten: 1.5, gyroSmooth: [4, 12] }
}
const noop = () => {}

/** One phone, connected with motion on, and a way to send it held input as the kit would. */
function setup() {
  const phone = { id: 'p1', kind: 'phone', connected: true, name: 'Test' }
  const party = { players: [phone], inputs: {}, public: {}, views: {}, view: (id) => (party.views[id] ??= {}), player: (id) => (id === 'p1' ? phone : null), pressed: noop, send: noop, on: noop }
  const input = { x: 0, y: 0, aimX: 0, aimY: 0, pressed: () => false, held: () => false, pointer: { x: 0, y: 0, pressed: false, released: false, down: false } }
  const motion = createMotion({ party, input, settings: { data: {} }, save: { data: { neutral: { b: 35, g: 0 } }, save: noop }, TUNING, sfx: { join: noop, center: noop } })
  const held = { tb: 35, tg: 0, u: [0, 0.57, 0.82], m: 0, f: false, fc: 0, ft: 0, gx: 0, gy: 0, st: 'on', still: true }
  return {
    motion,
    /** The phone's next held-input message, then one TV frame. */
    send(change) {
      Object.assign(held, change)
      party.inputs.p1 = { ...held }
      motion.update(1 / 60)
    }
  }
}

test('every trigger tap is a press, even while another finger rests on the button', () => {
  const p = setup()
  p.send({})
  p.send({ f: true, fc: 1, ft: 5000 })
  assert.equal(p.motion.firePressed, true)
  p.send({})
  assert.equal(p.motion.firePressed, false, 'a press lasts one frame')
  p.send({ f: true, fc: 2, ft: 5100 }) // second thumb lands; the button never let go
  assert.equal(p.motion.firePressed, true)
})

test('a tap shorter than one network update still counts', () => {
  const p = setup()
  p.send({})
  p.send({ f: false, fc: 1, ft: 5000 }) // down and up again before the next message
  assert.equal(p.motion.firePressed, true)
})

test('a press is dated no later than when it arrived', () => {
  const p = setup()
  p.send({})
  const before = performance.now() / 1000
  p.send({ fc: 1, ft: 5000 })
  assert.ok(p.motion.fireAt <= performance.now() / 1000)
  assert.ok(p.motion.fireAt <= before + 0.05)
})

test("the phone's gyro turning reaches the TV as degrees per frame, all of it", () => {
  const p = setup()
  p.send({})
  p.send({ gx: 10, gy: -4 })
  let x = p.motion.gyro.dx
  let y = p.motion.gyro.dy
  for (let i = 0; i < 30; i++) {
    p.send({})
    x += p.motion.gyro.dx
    y += p.motion.gyro.dy
  }
  assert.ok(Math.abs(x - 10) < 1e-6 && Math.abs(y + 4) < 1e-6, `played out ${x}, ${y}`)
  assert.ok(Math.abs(p.motion.gyroAhead.x) < 1e-6)
})
