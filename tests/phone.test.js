// The phone side (createPhoneMotion in controller.html): what the phone's sensors turn into.
// controller.html is sent to the phone as one page, so the engine can't be a module; the test
// lifts it out between its section markers and runs it against a stand-in browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../controller.html', import.meta.url), 'utf8')
const source = html.slice(html.indexOf('// ==== phone motion'), html.indexOf('// ==== end phone motion'))

/**
 * A phone with its sensors on. `angle` is how far the screen has turned (0 with rotation lock
 * on, however the phone is held). Device axes, as the browser reports them: x toward the
 * screen's right edge, y toward its top, z out of the screen.
 */
function phone({ angle = 0 } = {}) {
  const listeners = {}
  let ms = 1000
  const env = {
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    round: (v, k = 10) => Math.round(v * k) / k,
    DEFAULT_BETA: 35,
    parent: { postMessage() {} },
    addEventListener: (type, fn) => (listeners[type] = fn),
    screen: { orientation: { angle, lock: () => Promise.reject(new Error('not allowed')) } },
    performance: { now: () => ms },
    window: {}
  }
  const createPhoneMotion = new Function(...Object.keys(env), `${source}\nreturn createPhoneMotion`)(...Object.values(env))
  const pm = createPhoneMotion({ cfg: () => ({}), onSwing() {}, onChange() {} })
  return {
    /** Where the aim has moved to, in degrees: x right, y down (as the TV's sight moves). */
    get aim() {
      return { x: pm.gyro.x, y: pm.gyro.y }
    },
    /** How the phone is held: the browser's orientation angles. */
    hold({ beta, gamma }) {
      listeners.deviceorientation({ alpha: 0, beta, gamma })
    },
    /** Turn the phone at `rate` deg/s about its own x, y and z for `seconds`. */
    turn([x, y, z], seconds = 0.5) {
      for (let i = 0; i < Math.round(seconds * 60); i++) {
        ms += 1000 / 60
        // The browser names the rates about x, y, z "alpha, beta, gamma".
        listeners.devicemotion({ timeStamp: ms, acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: null, rotationRate: { alpha: x, beta: y, gamma: z } })
      }
    }
  }
}
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 0.6, `${what}: ${actual.toFixed(2)}, expected about ${expected}`)

// Held sideways like a light gun, screen facing the player, top of the phone to the left:
// the phone's x points at the ceiling and its y points left.
const SIDEWAYS = { beta: 0, gamma: -90 }
const TURN_LEFT = [30, 0, 0] // about the ceiling axis
const TIP_UP = [0, -30, 0] // about the level axis across the aim
const ROLL = [0, 0, 30] // about the line to the TV, like a steering wheel

for (const [name, angle] of [['rotation lock on', 0], ['the screen turned with it', 90]]) {
  test(`a sideways phone with ${name}: turning left moves the aim left, not up or down`, () => {
    const p = phone({ angle })
    p.hold(SIDEWAYS)
    p.turn(TURN_LEFT)
    near(p.aim.x, -15, 'left/right')
    near(p.aim.y, 0, 'up/down')
  })

  test(`a sideways phone with ${name}: tipping the aim up moves it up, not sideways`, () => {
    const p = phone({ angle })
    p.hold(SIDEWAYS)
    p.turn(TIP_UP)
    near(p.aim.x, 0, 'left/right')
    near(p.aim.y, -15, 'up/down')
  })
}

test('a sideways phone held the other way round aims the same', () => {
  const p = phone()
  p.hold({ beta: 0, gamma: 90 }) // top of the phone to the right: x points at the floor
  p.turn([-30, 0, 0]) // turning left
  p.turn([0, 30, 0]) // tipping the aim up
  near(p.aim.x, -15, 'left/right')
  near(p.aim.y, -15, 'up/down')
})

test('rolling the phone like a steering wheel does not move the aim', () => {
  const p = phone()
  p.hold(SIDEWAYS)
  p.turn(ROLL)
  near(p.aim.x, 0, 'left/right')
  near(p.aim.y, 0, 'up/down')
})

test('a phone held upright aims the same way: turn left for left, tip the top back for up', () => {
  const p = phone()
  p.hold({ beta: 90, gamma: 0 }) // portrait, screen facing the player: y points at the ceiling
  p.turn([0, 30, 0]) // turning left
  p.turn([30, 0, 0]) // tipping the aim up
  near(p.aim.x, -15, 'left/right')
  near(p.aim.y, -15, 'up/down')
})

test('the aim waits until the phone knows which way is up', () => {
  const p = phone()
  p.turn(TURN_LEFT) // no orientation reading yet: any direction would be a guess
  assert.deepEqual(p.aim, { x: 0, y: 0 })
  p.hold(SIDEWAYS)
  p.turn(TURN_LEFT)
  near(p.aim.x, -15, 'left/right')
})
