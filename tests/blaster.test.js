// Blaster Range, through the station's public seam: create(env) with a stand-in phone, input
// and clock, then run.update(dt) frame by frame as the game does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './browser-stubs.js'

const { default: blaster, RECENTER } = await import('../stations/blaster.js')
const { W, H } = await import('../gfx.js')

const TUNING = {
  blaster: { time: 60, spawn: 1.0, spawnEnd: 0.55, maxUp: 4, stay: 2.2, stayEnd: 1.3, slide: 110, slideEnd: 230, radius: 46, goldChance: 0, botAfter: 999, botChance: 0, botPenalty: 150, points: 100, bullseye: 0.3, bullseyeBonus: 50, comboStep: 0.1, comboCap: 10, slack: 16, sticky: 0.6, pxX: 50, pxY: 55, stickSpeed: 950, pointerHold: 0.8, cooldown: 0.12, rewindMax: 0.3 }
}
const noop = new Proxy({}, { get: () => () => {} })
const DT = 1 / 60

/** A phone aiming with its gyro, a stand-in TV clock, and helpers to drive frames. */
function setup({ phone = true } = {}) {
  let clock = 100
  const motion = {
    phoneLive: phone,
    phoneState: phone ? 'on' : 'none',
    source: phone ? 'phone' : 'stick',
    gyro: phone ? { dx: 0, dy: 0 } : null,
    gyroAhead: { x: 0, y: 0 },
    tilt: { x: 0, y: 0 },
    firePressed: false,
    fireAt: clock,
    centered: 0,
    buzz() {}
  }
  const input = { mode: 'gamepad', pointer: { x: 0, y: 0, active: false, pressed: false, down: false }, stickLabel: () => 'the left stick', label: () => 'A' }
  const env = { motion, input, sfx: noop, fx: noop, settings: { data: { tiltSensitivity: 1 } }, TUNING, now: () => clock }
  const run = blaster.create(env)
  const g = {
    run,
    motion,
    now: () => clock,
    /** One frame: optional gyro turn (degrees) and trigger press (fireAt: when it was pulled). */
    frame({ dx = 0, dy = 0, fire = false, fireAt } = {}) {
      clock += DT
      if (motion.gyro) motion.gyro = { dx, dy }
      motion.firePressed = fire
      motion.fireAt = fire ? fireAt ?? clock : clock
      run.update(DT)
    },
    wait(seconds) {
      for (let i = 0; i < Math.round(seconds / DT); i++) g.frame()
    },
    calibrate() {
      g.frame({ fire: true })
      g.wait(0.2) // past the shot cooldown
    }
  }
  return g
}

test('a round starts by asking the player to set their aim, and the clock waits until they do', () => {
  const g = setup()
  assert.equal(g.run.phase, 'calibrate')
  g.wait(3)
  assert.equal(g.run.timeLeft, 60)
  assert.equal(g.run.targets.length, 0)
})

test('setting the aim puts the sight in the middle, however far the phone had turned', () => {
  const g = setup()
  for (let i = 0; i < 30; i++) g.frame({ dx: 1.5, dy: -0.7 })
  assert.notEqual(g.run.sight.x, W / 2)
  g.frame({ fire: true })
  assert.equal(g.run.phase, 'play')
  assert.deepEqual([g.run.sight.x, g.run.sight.y], [W / 2, 390])
  g.wait(1)
  assert.ok(g.run.timeLeft < 60)
})

test('a controller or mouse needs no calibration', () => {
  const g = setup({ phone: false })
  assert.equal(g.run.phase, 'play')
})

test('turning the phone moves the sight like a mouse', () => {
  const g = setup()
  g.calibrate()
  g.frame({ dx: 2, dy: -1 })
  assert.equal(g.run.sight.x, W / 2 + 2 * 50)
  assert.equal(g.run.sight.y, 390 - 1 * 55)
})

test('the sight stops at the screen edge, so turning back moves it straight away', () => {
  const g = setup()
  g.calibrate()
  g.frame({ dx: 90 }) // far past the right edge: the extra turn is soaked up
  assert.equal(g.run.sight.x, W - 24)
  g.frame({ dx: -2 })
  assert.equal(g.run.sight.x, W - 24 - 2 * 50)
})

test('aiming down and shooting RECENTER AIM asks for the aim again, and the clock waits', () => {
  const g = setup()
  g.calibrate()
  g.frame({ dy: (RECENTER.y + RECENTER.h / 2 - 390) / 55 }) // down onto the button on the front counter
  g.frame({ fire: true })
  const left = g.run.timeLeft
  assert.equal(g.run.phase, 'calibrate')
  assert.equal(g.run.calibrating, 'recenter')
  assert.equal(g.run.recenters, 1)
  assert.equal(g.run.shots, 0, 'shooting the button is not a missed shot')
  g.wait(2)
  assert.equal(g.run.timeLeft, left)
  g.frame({ fire: true })
  assert.equal(g.run.phase, 'play')
  assert.deepEqual([g.run.sight.x, g.run.sight.y], [W / 2, 390])
})

test("the phone's Re-center button also asks for the aim again", () => {
  const g = setup()
  g.calibrate()
  g.motion.centered++
  g.frame()
  assert.equal(g.run.phase, 'calibrate')
})

test('a shot is judged where the target was when the trigger was pulled, not when it arrived', () => {
  for (const [lagged, expectHit] of [[true, true], [false, false]]) {
    const g = setup()
    g.calibrate()
    // A target sliding right across the sight: centre lane, starting right under it.
    const target = g.run.spawn({ lane: 1, x: W / 2, vx: 300, state: 'up', stay: 10 })
    const pulled = g.now()
    g.wait(0.2) // the press takes 0.2 s to reach the TV; the target moves on 60 px
    g.frame({ fire: true, fireAt: lagged ? pulled : undefined })
    assert.equal(target.state === 'hit', expectHit, lagged ? 'judged at the press: a hit' : 'judged on arrival: a miss')
    assert.equal(g.run.shots, 1)
  }
})

test('hits in a row build a combo that raises the points; a miss breaks it', () => {
  const g = setup()
  g.calibrate()
  const shootOne = () => {
    g.run.spawn({ lane: 1, x: W / 2, vx: 0, state: 'up', stay: 10 })
    g.frame({ fire: true })
    g.wait(0.2)
  }
  shootOne()
  const first = g.run.score
  shootOne()
  assert.equal(g.run.combo, 2)
  assert.ok(g.run.score - first > first, 'the second hit scores more than the first')
  g.frame({ dx: -8, fire: true }) // into empty wall
  assert.equal(g.run.combo, 0)
  assert.equal(g.run.hits, 2)
  assert.equal(g.run.shots, 3)
})

test("shooting a don't-shoot bot costs points and the combo", () => {
  const g = setup()
  g.calibrate()
  g.run.spawn({ lane: 1, x: W / 2, vx: 0, state: 'up', stay: 10 })
  g.frame({ fire: true })
  g.wait(0.2)
  const before = g.run.score
  g.run.spawn({ lane: 1, x: W / 2, vx: 0, state: 'up', stay: 10, kind: 'bot' })
  g.frame({ fire: true })
  assert.equal(g.run.score, Math.max(0, before - 150))
  assert.equal(g.run.combo, 0)
  assert.equal(g.run.bots, 1)
})

test('the round ends when the time runs out', () => {
  const g = setup()
  g.calibrate()
  g.wait(61)
  assert.equal(g.run.done, true)
})
