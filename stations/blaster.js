// Blaster Range: the phone is a light gun. Hold it sideways in both hands, back toward the TV,
// turn it to move the sight and tap anywhere on its screen to fire. 60 s of pop-up targets on
// three rails; hits build a combo, misses and shooting the "don't shoot" bots break it.
//
// Aim is the phone's gyro moving the sight like a mouse (motion.gyro): it can't know where the
// TV is, so it doesn't try. Instead the player sets the aim by shooting a centre target at the
// start, the sight stops at the screen edges (so slow drift is soaked up there), and if it has
// drifted anyway you aim down and shoot RECENTER AIM to set it again, without looking at the
// phone. Shots are judged where the targets were when the trigger was pulled (motion.fireAt),
// so network lag doesn't cost hits. Without a phone: the stick, the mouse or a tap aims.
import { C, H, W, clamp, gloss, glossFill, lerp, rand, rrect, shade, text } from '../gfx.js'

const RANGE_TOP = 110
const DESK_Y = 662 // the front counter: shots below it are not at the range
const AIM = { x: W / 2, y: 390 } // the calibration target, and where the sight starts
/** Three rails, back to front: targets pop up from behind each. */
const LANES = [
  { y: 300, scale: 0.78, shade: -0.25 },
  { y: 480, scale: 0.9, shade: -0.12 },
  { y: DESK_Y, scale: 1, shade: 0 }
]
/** On the front counter, above the control prompts: aim down and shoot it. */
export const RECENTER = { x: W / 2 - 150, y: 680, w: 300, h: 58 }
const MUZZLE_BASE = { x: 1090, y: 860 }
const POP = 0.16 // s to rise or drop

const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

export default {
  id: 'blaster',
  name: 'Blaster Range',
  blurb: 'Your phone is a light gun',
  phoneHint: 'Hold the phone sideways in both hands, back toward the TV. Turn it to aim; tap anywhere with a thumb to fire. Drifted? Aim down and shoot RECENTER AIM.',
  btn: 'FIRE',
  layout: 'trigger',
  music: { bpm: 124, root: 45, gain: 0.045, chords: [0, 3, 5, 7] },
  icon(ctx, x, y, s) {
    // a bullseye with a sight over it
    for (const [r, col] of [[0.42, '#f4f6fb'], [0.31, C.red], [0.2, '#f4f6fb'], [0.1, C.red]]) gloss(ctx, x, y, s * r, col, { edge: s * 0.04, shine: 0.6 })
    ctx.strokeStyle = C.dark
    ctx.lineWidth = s * 0.07
    ctx.beginPath()
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(x + dx * s * 0.3, y + dy * s * 0.3)
      ctx.lineTo(x + dx * s * 0.56, y + dy * s * 0.56)
    }
    ctx.stroke()
  },
  howTo: (input, motion) =>
    motion?.phoneLive && motion.phoneState === 'on'
      ? 'Hold the phone sideways in both hands, back toward the screen'
      : `Aim with ${input.stickLabel()} or the mouse · ${input.label('a')} or tap to fire`,
  create(env) {
    const { motion, sfx, fx, input, settings, TUNING } = env
    const T = TUNING.blaster
    const clock = env.now ?? (() => performance.now() / 1000)
    const sight = { x: AIM.x, y: AIM.y }
    const lastPointer = { x: input.pointer.x, y: input.pointer.y }
    let pointerAt = -99
    let centeredSeen = motion.centered
    let t = 0
    let spawnIn = 0.6
    let cooldown = 0
    let recoil = 0
    let beam = null
    const targets = []
    const run = {
      score: 0,
      done: false,
      timeLeft: T.time,
      /** 'calibrate' while the player sets the aim by shooting the centre target; else 'play'. */
      phase: aimsByGyro() ? 'calibrate' : 'play',
      /** Why we're calibrating: 'start' or 'recenter'. */
      calibrating: 'start',
      sight,
      targets,
      combo: 0,
      bestCombo: 0,
      hits: 0,
      shots: 0,
      bullseyes: 0,
      bots: 0,
      recenters: 0,
      update,
      draw,
      /** For tests and the debug hook: a target up on a rail. */
      spawn,
      hudRight: () => (run.phase === 'calibrate' ? 'Aim' : `${Math.ceil(Math.max(0, run.timeLeft))}s`),
      stats: () => [
        ['Targets hit', run.hits],
        ['Accuracy', run.shots ? `${Math.round((run.hits / run.shots) * 100)}%` : '-'],
        ['Bullseyes', run.bullseyes],
        ['Best combo', run.bestCombo]
      ],
      prompts: () => [
        ['a', 'Fire'],
        ['y', 'Recenter'],
        ['menu', 'Pause']
      ]
    }

    /** The phone's own motion aims (not its touch pad, not a stand-in). */
    function aimsByGyro() {
      return motion.phoneLive && motion.phoneState === 'on'
    }
    function sens() {
      return settings?.data?.tiltSensitivity ?? 1
    }
    /** The sight stops at the edges: turning further is simply lost, like a mouse at the edge. */
    function clampSight(p) {
      p.x = clamp(p.x, 24, W - 24)
      p.y = clamp(p.y, RANGE_TOP, H - 24)
      return p
    }
    function startCalibrate(why) {
      if (!aimsByGyro()) {
        // Stand-ins aim absolutely already; just put the sight back in the middle.
        sight.x = AIM.x
        sight.y = AIM.y
        return
      }
      run.phase = 'calibrate'
      run.calibrating = why
      if (why === 'recenter') run.recenters++
      sfx.center()
    }

    function spawn(opts = {}) {
      const k = clamp(t / T.time, 0, 1)
      const free = LANES.map((_, i) => i).filter((i) => targets.filter((g) => g.lane === i && g.state !== 'gone').length < 2)
      const lane = opts.lane ?? free[Math.floor(Math.random() * free.length)] ?? 0
      const L = LANES[lane]
      const kind = opts.kind ?? (t > T.botAfter && Math.random() < T.botChance ? 'bot' : Math.random() < T.goldChance ? 'gold' : 'disc')
      const slide = opts.vx ?? (Math.random() < lerp(0.35, 0.7, k) ? lerp(T.slide, T.slideEnd, k) * (Math.random() < 0.5 ? -1 : 1) * (kind === 'gold' ? 1.5 : 1) : 0)
      const r = T.radius * L.scale * (kind === 'gold' ? 0.75 : 1)
      const g = {
        lane,
        kind,
        x: opts.x ?? rand(140, W - 140),
        vx: slide,
        r,
        state: opts.state ?? 'rise',
        a: 0, // time in this state
        stay: opts.stay ?? lerp(T.stay, T.stayEnd, k) * (kind === 'gold' ? 0.75 : 1),
        p: opts.state === 'up' ? 1 : 0, // how far up (0 hidden, 1 up)
        spin: 0,
        hist: []
      }
      targets.push(g)
      record(g)
      return g
    }
    /** Where a target's centre is (it rises from behind its rail). */
    function posOf(g) {
      return { x: g.x, y: LANES[g.lane].y - (g.r + 24 * LANES[g.lane].scale) * g.p - 8 * (1 - g.p), r: g.r, live: (g.state === 'rise' || g.state === 'up' || g.state === 'drop') && g.p > 0.5 }
    }
    function record(g) {
      const now = clock()
      g.hist.push({ t: now, ...posOf(g) })
      while (g.hist.length > 2 && g.hist[1].t < now - T.rewindMax - 0.1) g.hist.shift()
    }
    /** Where a target was at TV time ts: the last record at or before it. */
    function at(g, ts) {
      let best = g.hist[0]
      for (const h of g.hist) if (h.t <= ts + 1e-6) best = h
      return best ?? { ...posOf(g), t: clock() }
    }

    function update(dt) {
      cooldown = Math.max(0, cooldown - dt)
      recoil = Math.max(0, recoil - dt * 7)
      if (beam) beam.life -= dt
      if (beam && beam.life <= 0) beam = null
      aim(dt)

      if (motion.centered !== centeredSeen) {
        centeredSeen = motion.centered
        startCalibrate('recenter')
      }
      if (run.phase === 'calibrate') {
        if (!aimsByGyro()) run.phase = 'play'
        else if (motion.firePressed) {
          // Wherever the phone points now is the middle of the screen.
          sight.x = AIM.x
          sight.y = AIM.y
          run.phase = 'play'
          cooldown = T.cooldown
          sfx.center()
          motion.buzz(30)
          fx.float(AIM.x, AIM.y - 90, 'Aim set!', C.lime, 40)
        }
        return
      }

      t += dt
      run.timeLeft -= dt
      if (wantsShot()) shoot()

      spawnIn -= dt
      const up = targets.filter((g) => g.state !== 'gone').length
      if (spawnIn <= 0 && up < T.maxUp) {
        spawn()
        spawnIn = lerp(T.spawn, T.spawnEnd, clamp(t / T.time, 0, 1)) * rand(0.8, 1.2)
      }
      for (const g of targets) {
        g.a += dt
        if (g.state === 'rise') {
          g.p = Math.min(1, g.a / POP)
          if (g.a >= POP) ((g.state = 'up'), (g.a = 0))
        } else if (g.state === 'up') {
          if (g.a >= g.stay) ((g.state = 'drop'), (g.a = 0))
        } else if (g.state === 'drop') {
          g.p = Math.max(0, 1 - g.a / POP)
          if (g.a >= POP) g.state = 'gone'
        } else if (g.state === 'hit') {
          g.spin += dt * 14
          g.p = Math.max(0, 1 - g.a / 0.35)
          if (g.a >= 0.35) g.state = 'gone'
        }
        if (g.state === 'rise' || g.state === 'up') {
          g.x += g.vx * dt
          if ((g.x < 90 && g.vx < 0) || (g.x > W - 90 && g.vx > 0)) g.vx *= -1
        }
        record(g)
      }
      for (let i = targets.length - 1; i >= 0; i--) if (targets[i].state === 'gone' && clock() - targets[i].hist.at(-1).t > T.rewindMax + 0.1) targets.splice(i, 1)
      if (run.timeLeft <= 0) run.done = true
    }

    /** Move the sight: the phone's gyro like a mouse, else the mouse/finger, else the stick. */
    function aim(dt) {
      const p = input.pointer
      const moved = p.x !== lastPointer.x || p.y !== lastPointer.y
      lastPointer.x = p.x
      lastPointer.y = p.y
      if (p.active && p.y > RANGE_TOP && (p.pressed || (moved && (input.mode === 'mouse' || p.down)))) {
        sight.x = p.x
        sight.y = p.y
        pointerAt = t
      } else if (motion.source === 'phone' && motion.gyro) {
        if (t - pointerAt < T.pointerHold && run.phase === 'play') return
        // A little stickiness over a target (aim assist), never a pull toward it.
        const over = targets.some((g) => g.kind !== 'bot' && posOf(g).live && Math.hypot(posOf(g).x - sight.x, posOf(g).y - sight.y) < g.r * 1.1)
        const k = sens() * (over ? T.sticky : 1)
        sight.x += motion.gyro.dx * T.pxX * k
        sight.y += motion.gyro.dy * T.pxY * k
      } else if (Math.hypot(motion.tilt.x, motion.tilt.y) > 0) {
        // The stick, or the phone's touch pad.
        sight.x += motion.tilt.x * T.stickSpeed * dt
        sight.y += motion.tilt.y * T.stickSpeed * dt
      }
      clampSight(sight)
    }

    function wantsShot() {
      const p = input.pointer
      if (motion.firePressed && !(input.mode === 'touch' && p.pressed)) return 'trigger'
      if (p.pressed && p.y > RANGE_TOP) return 'pointer'
      return null
    }

    function shoot() {
      if (cooldown > 0) return
      cooldown = T.cooldown
      const now = clock()
      // Turning that has arrived but not yet been played out still belongs to this shot.
      const ahead = motion.source === 'phone' && motion.gyro ? motion.gyroAhead : { x: 0, y: 0 }
      const shot = clampSight({ x: sight.x + ahead.x * T.pxX * sens(), y: sight.y + ahead.y * T.pxY * sens() })
      const ts = clamp(motion.fireAt ?? now, now - T.rewindMax, now)
      recoil = 1
      beam = { x: shot.x, y: shot.y, life: 0.12 }
      sfx.bang()
      fx.kick(4)
      motion.buzz(25)

      if (inRect(shot.x, shot.y, RECENTER)) return startCalibrate('recenter')
      if (shot.y >= DESK_Y) return fx.burst(shot.x, shot.y, 'rgba(255,255,255,0.6)', 5, 100, { gravity: 0, life: 0.25, shape: 'circle' })

      run.shots++
      let target = null
      let bestD = Infinity
      let bestPos = null
      for (const g of targets) {
        if (g.state === 'hit' || g.state === 'gone') continue
        const pos = at(g, ts)
        if (!pos.live) continue
        const d = Math.hypot(pos.x - shot.x, pos.y - shot.y)
        if (d < pos.r + T.slack && d / pos.r < bestD) {
          bestD = d / pos.r
          target = g
          bestPos = pos
        }
      }
      if (!target) {
        if (run.combo >= 3) fx.float(shot.x, shot.y - 50, 'Combo lost', C.pink, 26)
        run.combo = 0
        fx.burst(shot.x, shot.y, 'rgba(255,255,255,0.7)', 6, 120, { gravity: 0, life: 0.3, shape: 'circle' })
        return
      }
      target.state = 'hit'
      target.a = 0
      if (target.kind === 'bot') {
        run.bots++
        run.combo = 0
        run.score = Math.max(0, run.score - T.botPenalty)
        fx.float(bestPos.x, bestPos.y - 60, `-${T.botPenalty} Don't shoot bots!`, C.pink, 30)
        fx.burst(bestPos.x, bestPos.y, C.pink, 14, 320, { gravity: 500, life: 0.6 })
        sfx.miss()
        motion.buzz(90)
        return
      }
      run.combo++
      run.bestCombo = Math.max(run.bestCombo, run.combo)
      run.hits++
      const bull = bestD < T.bullseye
      if (bull) run.bullseyes++
      const mult = 1 + Math.min(run.combo - 1, T.comboCap) * T.comboStep
      const pts = Math.round((T.points * (target.kind === 'gold' ? 3 : 1) + (bull ? T.bullseyeBonus : 0)) * mult)
      run.score += pts
      const col = target.kind === 'gold' ? C.gold : C.red
      fx.burst(bestPos.x, bestPos.y, col, 16, 380, { gravity: 600, life: 0.7 })
      fx.burst(bestPos.x, bestPos.y, '#fff', 8, 260, { gravity: 600, life: 0.6 })
      fx.float(bestPos.x, bestPos.y - 60, bull ? `Bullseye! +${pts}` : `+${pts}`, target.kind === 'gold' ? C.gold : C.ink, bull ? 36 : 32)
      sfx.hit()
      motion.buzz(60)
    }

    // ---- drawing ----------------------------------------------------------------------------

    let wall = null
    function bake() {
      const c = document.createElement('canvas')
      c.width = W * 2
      c.height = H * 2
      const g = c.getContext('2d')
      g.scale(2, 2)
      // The test bay: a deep blue wall with a lit blueprint grid and a warm lamp glow.
      const bg = g.createLinearGradient(0, 0, 0, H)
      bg.addColorStop(0, '#1b2a66')
      bg.addColorStop(1, '#0d1436')
      g.fillStyle = bg
      g.fillRect(0, 0, W, H)
      const lamp = g.createRadialGradient(W / 2, 120, 0, W / 2, 120, 700)
      lamp.addColorStop(0, 'rgba(255,210,140,0.28)')
      lamp.addColorStop(1, 'rgba(255,210,140,0)')
      g.fillStyle = lamp
      g.fillRect(0, 0, W, H)
      g.strokeStyle = 'rgba(140,170,255,0.12)'
      g.lineWidth = 1.5
      g.beginPath()
      for (let x = 0; x <= W; x += 40) ((g.moveTo(x, 0)), g.lineTo(x, H))
      for (let y = 0; y <= H; y += 40) ((g.moveTo(0, y)), g.lineTo(W, y))
      g.stroke()
      // Distance marks painted on the wall.
      g.font = '800 22px system-ui, sans-serif'
      g.fillStyle = 'rgba(160,190,255,0.35)'
      g.textAlign = 'left'
      ;['25 m', '15 m', '5 m'].forEach((s, i) => g.fillText(s, 28, LANES[i].y - 14))
      wall = c
    }

    function drawRail(ctx, L, i) {
      const h = i === 2 ? H - L.y : 34 * L.scale
      const col = shade(C.panelHi ?? '#2a3a7a', L.shade)
      ctx.lineWidth = 5
      ctx.strokeStyle = C.dark
      rrect(ctx, -10, L.y, W + 20, h, i === 2 ? 0 : 10)
      ctx.stroke()
      glossFill(ctx, i === 2 ? '#3a4a8c' : col, 0, L.y, W, h)
      // hazard stripe along the top edge
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, L.y + 4, W, 10 * L.scale)
      ctx.clip()
      for (let x = -20; x < W + 20; x += 36) {
        ctx.fillStyle = C.gold
        ctx.beginPath()
        ctx.moveTo(x, L.y + 4)
        ctx.lineTo(x + 18, L.y + 4)
        ctx.lineTo(x + 8, L.y + 4 + 10 * L.scale)
        ctx.lineTo(x - 10, L.y + 4 + 10 * L.scale)
        ctx.fill()
      }
      ctx.restore()
    }

    function drawTarget(ctx, g) {
      const pos = posOf(g)
      const L = LANES[g.lane]
      ctx.save()
      // Only the part above the rail shows: targets rise out from behind it.
      ctx.beginPath()
      ctx.rect(0, 0, W, L.y)
      ctx.clip()
      // the stand
      ctx.fillStyle = C.dark
      ctx.fillRect(pos.x - 5 * L.scale, pos.y, 10 * L.scale, L.y - pos.y + 4)
      ctx.translate(pos.x, pos.y)
      if (g.state === 'hit') ctx.scale(Math.cos(g.spin), 1)
      const r = g.r
      if (g.kind === 'bot') {
        // a "don't shoot" lab bot: pink, with a visor and a frown
        rrect(ctx, -r, -r * 0.9, r * 2, r * 1.8, r * 0.45)
        ctx.lineWidth = 5
        ctx.strokeStyle = C.dark
        ctx.stroke()
        glossFill(ctx, C.pink, -r, -r * 0.9, r * 2, r * 1.8)
        rrect(ctx, -r * 0.7, -r * 0.45, r * 1.4, r * 0.55, r * 0.2)
        ctx.fillStyle = C.dark
        ctx.fill()
        ctx.fillStyle = C.lime
        for (const dx of [-0.32, 0.32]) {
          ctx.beginPath()
          ctx.arc(dx * r, -r * 0.18, r * 0.12, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.strokeStyle = C.dark
        ctx.lineWidth = 4
        ctx.beginPath()
        ctx.arc(0, r * 0.62, r * 0.3, Math.PI * 1.15, Math.PI * 1.85)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(0, -r * 0.9)
        ctx.lineTo(0, -r * 1.25)
        ctx.stroke()
        gloss(ctx, 0, -r * 1.3, r * 0.14, C.gold, { edge: 3 })
      } else {
        const rings = g.kind === 'gold' ? [[1, C.gold], [0.72, '#fff4c2'], [0.46, C.gold], [0.22, C.orange]] : [[1, '#f4f6fb'], [0.72, C.red], [0.46, '#f4f6fb'], [0.22, C.red]]
        for (const [k, col] of rings) gloss(ctx, 0, 0, r * k, col, { edge: k === 1 ? 5 : 2.5, shine: k === 1 ? 0.9 : 0.4 })
      }
      ctx.restore()
    }

    function drawBlaster(ctx) {
      // A chunky toy blaster in the bottom corner, always pointing at the sight.
      const a = Math.atan2(sight.y - MUZZLE_BASE.y, sight.x - MUZZLE_BASE.x)
      const back = recoil * 22
      ctx.save()
      ctx.translate(MUZZLE_BASE.x, MUZZLE_BASE.y)
      ctx.rotate(a)
      ctx.translate(-back, 0)
      ctx.lineWidth = 6
      ctx.strokeStyle = C.dark
      // barrel
      rrect(ctx, 120, -22, 150, 44, 14)
      ctx.stroke()
      glossFill(ctx, C.teal, 120, -22, 150, 44)
      rrect(ctx, 262, -28, 30, 56, 10)
      ctx.stroke()
      glossFill(ctx, C.orange, 262, -28, 30, 56)
      // body
      rrect(ctx, -40, -50, 180, 100, 30)
      ctx.stroke()
      glossFill(ctx, C.orange, -40, -50, 180, 100)
      gloss(ctx, 60, 0, 18, C.lime, { edge: 4 })
      ctx.restore()
    }
    function muzzle() {
      const a = Math.atan2(sight.y - MUZZLE_BASE.y, sight.x - MUZZLE_BASE.x)
      const d = 292 - recoil * 22
      return { x: MUZZLE_BASE.x + Math.cos(a) * d, y: MUZZLE_BASE.y + Math.sin(a) * d }
    }

    function drawSight(ctx, x, y, r, col) {
      for (const [w, c] of [[10, C.dark], [5, col]]) {
        ctx.lineWidth = w
        ctx.strokeStyle = c
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.moveTo(x + dx * r * 0.45, y + dy * r * 0.45)
          ctx.lineTo(x + dx * r * 1.35, y + dy * r * 1.35)
        }
        ctx.stroke()
      }
    }

    function draw(ctx) {
      if (!wall) bake()
      ctx.drawImage(wall, 0, 0, W, H)
      // back to front: each lane's targets, then its rail in front of them
      LANES.forEach((L, i) => {
        for (const g of targets) if (g.lane === i && g.state !== 'gone') drawTarget(ctx, g)
        drawRail(ctx, L, i)
      })
      // RECENTER AIM, on the front counter: aim down and shoot it.
      const overBtn = inRect(sight.x, sight.y, RECENTER)
      const b = RECENTER
      rrect(ctx, b.x, b.y, b.w, b.h, 18)
      ctx.lineWidth = 5
      ctx.strokeStyle = C.dark
      ctx.stroke()
      glossFill(ctx, overBtn ? C.gold : '#9aa6d6', b.x, b.y, b.w, b.h)
      text(ctx, 'RECENTER AIM', b.x + b.w / 2, b.y + b.h / 2 + 1, { size: 26, weight: 900, color: C.dark })

      if (run.combo >= 2) text(ctx, `Combo ${run.combo}  ×${(1 + Math.min(run.combo - 1, T.comboCap) * T.comboStep).toFixed(1)}`, 40, 128, { size: 26, weight: 900, align: 'left', color: C.lime, outline: 7 })

      if (run.phase === 'calibrate') return drawCalibrate(ctx)

      if (beam) {
        const m = muzzle()
        const k = beam.life / 0.12
        ctx.lineCap = 'round'
        for (const [w, col] of [[22 * k, 'rgba(42,209,201,0.35)'], [9 * k, C.teal], [3 * k, '#fff']]) {
          ctx.lineWidth = Math.max(0.5, w)
          ctx.strokeStyle = col
          ctx.beginPath()
          ctx.moveTo(m.x, m.y)
          ctx.lineTo(beam.x, beam.y)
          ctx.stroke()
        }
        ctx.lineCap = 'butt'
        gloss(ctx, m.x, m.y, 16 * k + 4, '#fff7c2', { edge: 0, shine: 0.4 })
      }
      drawBlaster(ctx)
      drawSight(ctx, sight.x, sight.y, 34 + recoil * 10, overBtn ? C.gold : C.lime)
    }

    function drawCalibrate(ctx) {
      ctx.fillStyle = 'rgba(10,15,34,0.55)'
      ctx.fillRect(0, 0, W, H)
      const pulse = 1 + Math.sin(performance.now() / 160) * 0.06
      for (const [k, col] of [[1, '#f4f6fb'], [0.7, C.lime], [0.42, '#f4f6fb'], [0.18, C.lime]]) gloss(ctx, AIM.x, AIM.y, 70 * k * pulse, col, { edge: k === 1 ? 6 : 3, shine: 0.5 })
      const head = run.calibrating === 'recenter' ? 'Recenter your aim' : 'Set your aim'
      text(ctx, head, W / 2, 200, { size: 52, weight: 900, outline: 12 })
      text(ctx, 'Point the phone at this target, then FIRE', W / 2, 520, { size: 32, weight: 800, outline: 9 })
      text(ctx, 'Drifted later? Aim down and shoot RECENTER AIM', W / 2, 568, { size: 22, weight: 700, color: C.quiet, outline: 6 })
      drawBlaster(ctx)
    }

    return run
  }
}
