# Aiming a light gun on a TV with a phone's browser

*Research note, 2026-11-22. Covers Motion Lab 1.9.0 (Blaster Range), and line numbers refer to that version. Defects 1 and 2 (gyro axis order, pitch axis from the screen's rotation) and the made-up starting pose for aiming (part of defect 4) were fixed afterwards in 1.9.1, which also added tests for the phone engine (defect 13); everything else here is still open.*

**How to read the citations.** Every claim links to its source. Each source in [Sources](#sources) carries one of three marks:

- **[D]** read directly in this session (spec source, engine source, official docs, project code).
- **[S]** seen only as a web-search summary. The page itself could not be opened from this sandbox, so the wording and numbers are second-hand. Check before relying on them.
- **[U]** unverified: from memory or not found in a primary source.

This sandbox could only open `raw.githubusercontent.com`, `developer.android.com` and `developer.apple.com`. See [Sites that could not be fetched](#sites-that-could-not-be-fetched). W3C specs were read from their source files on GitHub, which is where the editors write them.

---

## Short answer

**Fix two bugs first. As far as the git history shows (the oldest tree is 1.8.0), the gyro aiming has never worked as designed, so nobody has yet played the thing the changelog rejected.**

| | What | One-line reason |
|---|---|---|
| **Recommend** | An **anchored IMU pointer**: the sight sits at `centre + k × (aim angle − aim angle at last re-centre)`, where the aim angle comes from the phone's OS-fused orientation, with the gyro rate as the fast path, one trigger pull to re-centre, and the latency chain cut down. | Pitch stops drifting (it is tied to gravity), every accumulated error we add ourselves disappears, and it needs no new permission, no new API and almost no new data: the orientation already reaches `sample()`. |
| **Fallback** | **Gyro-as-mouse, fixed up** to JoyShockMapper's numbers, with a "hold to freeze the sight" thumb zone. It is the same code with the anchor switched off. | Works wherever `devicemotion` works, including a phone whose orientation data turns out unusable. |
| **Drop** | The current `rotationRate` axis mapping and the pitch axis taken from `screen.orientation.angle`. | Plain bugs: see [Defects](#defects-in-the-current-code) 1 and 2. |
| **Drop** | Camera plus markers as the default way to aim. | A camera prompt in a party game, a kit change, fingers over the lens in a two-handed landscape grip, and no measured cost on phones. Keep it as a later experiment for automatic re-centring only. |
| **Drop** | The 30 ms playout smoothing on the TV, the "sticky" slowdown over targets, and gyro bias learning in our own code. | Each adds delay or quietly shifts the aim; the sources say not to. |

**Why the history does not settle the question.** `DESIGN.md` 1.8.0 concluded that "pointing at the screen can't be made to feel right with a phone". But the phone code at that version already read the gyro axes in the wrong order ([commit `eae34b1`, `controller.html` lines 160 and 232-233][local-180]), the same lines that are in 1.9.0. The 1.5.0 to 1.7.1 trees are not in git, so this part is inferred: the 1.5.0 gyro-mouse and the 1.7.0 "gyro between readings" very likely ran on the same mapping, as 1.9.0 does. And [`DESIGN.md:137`][local-design] says the landscape handling was "tested with simulated sensors only". So the playtests most likely judged a broken gyro term, not gyro aiming. What 1.7.0 got right (absolute pointing from the full orientation) would have been fought by a gyro term that pushed the sight the wrong way between readings.

**Order of work.**

1. Fix defects 1 and 2 (an afternoon) and play it. This alone may change the verdict.
2. Build the anchored pointer: aim packet at 60 Hz, no playout smoothing, bigger hit areas, wave-start re-centres, two-shot calibration.
3. Read the round trip on the Bench. Only if the network is the largest part of the delay, add a direct phone-to-TV channel in the kit.
4. Optional, later: one camera experiment for automatic re-centring.

---

## The headline finding: the gyro axes are read in the wrong order

`controller.html` assumes `rotationRate.alpha` is rotation about z, `beta` about x and `gamma` about y ([`controller.html:227`, `:242-243`][local-ctl]). That is how the *orientation* angles are named, and one MDN page says the same of the rates ([MDN `DeviceMotionEventRotationRate.alpha`: "rate of rotation around the Z axis"][mdn-alpha]). It is wrong for the rates:

- The spec's getter steps: `alpha` returns the **x** axis rotation rate, `beta` the **y** axis rate, `gamma` the **z** axis rate ([Device Orientation and Motion, §DeviceMotionEventRotationRate][do-spec]).
- Chromium builds the object from `gyro.x, gyro.y, gyro.z` in that order ([`device_motion_event_pump.cc` lines 165-168][cr-pump]; the constructor's parameters are `alpha, beta, gamma` [`device_motion_event_rotation_rate.h`][cr-rr]).
- WebKit on iOS passes Core Motion's `rotationRate.x, .y, .z` into `RotationRate::create(alpha, beta, gamma)` ([`WebCoreMotionManager.mm` line 243][wk-wcmm], [`DeviceMotionClientIOS.mm`][wk-dmci], [`DeviceMotionData.h`][wk-dmd]).
- MDN's other page agrees with the engines: `alpha` is "about its X axis" ([MDN `DeviceMotionEvent.rotationRate`][mdn-rr]). MDN contradicts itself, which is probably where our assumption came from.
- A 2017 W3C mailing-list pull request says Chrome on Android, Firefox on Android and Safari on iPhone all implement x = alpha, y = beta, z = gamma, and proposes changing the spec to match ([public-geolocation, Aug 2017][w3c-list], **[S]**).
- One spec example still follows the old naming (a car turning about the phone's vertical axis reported as `gamma`), so the spec text is not fully consistent with itself ([same spec, example in §Device Motion][do-spec]). The normative getter steps and both engines agree with each other.

**What the player sees** (worked out from our code with the real axis order; not run on a phone here). Write the true rates as ω<sub>x</sub>, ω<sub>y</sub>, ω<sub>z</sub>:

| How the phone is held | Sight left/right follows | Sight up/down follows | Turning the phone left/right |
|---|---|---|---|
| Sideways, **rotation lock on** (`angle` = 0) | ω<sub>y</sub> (tipping the aim up/down) | ω<sub>y</sub> again | does nothing |
| Sideways, auto-rotate on (`angle` = 90 or 270) | ω<sub>y</sub> (tipping up/down) | ω<sub>z</sub> (rolling like a steering wheel) | does nothing |
| Upright portrait | ω<sub>z</sub> (rolling) | ω<sub>y</sub> (turning left/right) | moves the sight up/down |

In every hold, turning the phone left or right never moves the sight left or right. That fits "is very bad and doesn't really work at all".

**Two-minute check on a real phone:** lay it flat on a table and spin it like a compass needle. Per the spec and both engines, `rotationRate.gamma` should be the one that moves. Our code expects `alpha`.

---

## Comparison of the candidates

| Approach | Drift | Latency | Setup effort for a casual player | Browser / iOS support | Build cost |
|---|---|---|---|---|---|
| **Gyro-as-mouse, fixed up** (integrate `rotationRate` ourselves) | Yaw and pitch both wander: gyro bias, rates rounded to 0.1°/s ([spec][do-spec], [Chromium][cr-util]), plus every clamp, tightening and slowdown we apply. Needs frequent re-centring. | Lowest possible on the phone: one sample. Same network cost as the others. | One trigger pull to set the aim; re-centre when it slips. | Everywhere `devicemotion` exists: Chrome Android, iOS Safari after a tap ([BCD][bcd-dme]). | Smallest: two bug fixes and new numbers. |
| **Absolute orientation pointer with re-centre** (recommended, with the gyro rate as fast path) | Pitch: none (tied to gravity: [Android][and-pos], [Apple][apple-xarb]). Yaw: the OS's own drift, about 1-2°/min on Android per one benchmark ([RoNIN][ronin], **[S]**); Android only promises "the same order of magnitude as the gyroscope drifts around the Z axis" ([Android][and-sensor]). | Orientation is quantised to 0.1° ([spec][do-spec], [Chromium][cr-util]), about 5 px here, so it needs the rate as a fast path or a light filter. Otherwise the same as above. | Same as above. Re-centres can be hidden in the game (a "start the wave" target every 20 s). | Same events we already use. Chrome Android: `deviceorientation` is relative, backed by the game rotation vector ([Chromium][cr-ori], [Chromium Android][cr-psp], [BCD note][bcd-doe]). iOS: Core Motion attitude with gyro and accelerometer only ([WebKit][wk-wcmm], [Apple][apple-proc]). | Small: my estimate is about 50 lines on the phone and 30 on the TV. |
| **Camera plus markers** (phone camera finds the screen, homography gives the aim point) | None: true line of sight, the way a Sinden gun works ([Sinden shop][sinden], **[S]**). | Camera frames at 30-60 fps plus the browser's camera pipeline; delay on phones not found in any primary source (**[U]**). Too slow alone; needs the gyro in between. | A camera permission prompt, markers or a border drawn on the TV, a clear view, fingers kept off the lens. | `getUserMedia` exists on both ([BCD][bcd-gum]). Blocked in our frame today: `allow` lacks `camera` ([`shell.js:240`][local-shell]; camera's default allowlist is `'self'` [Media Capture][gum-spec]). | Large: kit change in `pushplay`, a detector small enough to ship inside `controller.html`, new TV art, tuning per phone. |
| **Hybrid: IMU pointer plus occasional camera fixes** | None once the camera sees the screen; falls back to IMU drift when it does not. | Same as the IMU pointer: the camera only corrects slowly, so its delay stops mattering. | Camera prompt, but can be optional ("precision mode"). | As camera. | Largest: everything above plus fusing the two. |

---

## Recommended numbers

| Setting | Now | Recommended start | Source |
|---|---|---|---|
| Gyro axes | `alpha`=z, `beta`=x, `gamma`=y | `alpha`=x, `beta`=y, `gamma`=z | [Spec][do-spec], [Chromium][cr-pump], [WebKit][wk-wcmm] |
| Pitch axis | Screen x from `screen.orientation.angle` | The level axis across the aim: `right = normalize(up_y, −up_x, 0)` in device axes, `pitchRate = ω · right`, `yawRate = ω · up`. No screen angle anywhere. | Device axes do not turn with the screen ([spec, §Device Orientation][do-spec]); JoyShockMapper's world-space code derives the pitch axis from gravity the same way ([GamepadMotionHelpers][gmh]) |
| Aim angles | Sum of rates | From the fused orientation: aim vector = the phone's −z ("out of the back of the screen"), yaw = its heading, pitch = its elevation | The spec works this exact vector through as its example ([spec, appendix "compass heading"][do-spec]) |
| Anchor | none | Rate moves the sight at once; the sight is pulled to the orientation-derived angle with a time constant of about 0.3 s (try 0.2-0.5) | **[U]** starting value, tune on a phone. Reason: 0.1° quantisation ([Chromium][cr-util]) |
| Sensitivity | 50 px/° across, 55 px/° up/down ([`game.js:63`][local-game]) | 50 px/° on **both** axes (1280 px = 25.6°). Better: a two-shot calibration (one target near each side) that measures px/° for this player's TV and seat. | 25.6° across is "GYRO_SENS 14" on JoyShockMapper's 2D scale; its 2D sample uses 8 to 16, i.e. 45° to 22.5° across ([README][jsm-readme], [`_2Dmouse.txt`][jsm-2d]). 1.7.1's playtest landed on 55 ([`DESIGN.md`][local-design]) |
| Acceleration | none | none | Mouse acceleration has to be off for JoyShockMapper "to work accurately" ([README][jsm-readme]). Its samples do offer a speed-based sensitivity (8 at 5°/s rising to 16 at 75°/s, [`_2Dmouse.txt`][jsm-2d]); that suits a mouse cursor but breaks a fixed angle-to-pixel mapping, which a pointer needs |
| Deadzone / cutoff | none | none | "It's never good. Don't use it." ([JSM README, `GYRO_CUTOFF_SPEED`][jsm-readme]) |
| Tightening | below 1.5°/s ([`game.js:53`][local-game]) | Anchored mode: off (filter the sight position instead). Fallback gyro-mouse: keep ≤ 2°/s | JSM's default is 0; the author uses it "only … as a last resort"; the 2D sample uses 5°/s together with a gyro-off button ([README][jsm-readme], [`_2Dmouse.txt`][jsm-2d]) |
| Smoothing | 4 samples, full below 4°/s, none above 12°/s ([`game.js:54`][local-game]) | Full below 2.5°/s, none above 5°/s, over 0.125 s **of time**, not a count of samples | `GYRO_SMOOTH_THRESHOLD` 5 in the 2D sample, `GYRO_SMOOTH_TIME` default 0.125 s; "a game should *never* have *any* smoothing apply to *any input faster than a very small threshold*" ([README][jsm-readme], [`_2Dmouse.txt`][jsm-2d]) |
| Sight position filter (alternative to the row above) | One Euro on tilt only | One Euro on the sight: start at `mincutoff` 1 Hz, `beta` 0; lower `mincutoff` until a still hand is steady, then raise `beta` until fast moves have no lag | The authors' tuning procedure ([1€ filter][oneeuro] **[D]**, [procedure][oneeuro-tune] **[S]**). We already have the filter in [`motion.js:39-52`][local-motion] |
| Bias learning in our code | on, capped at 1.5°/s ([`controller.html:239-240`][local-ctl]) | off | Android's `TYPE_GYROSCOPE` already has drift compensation ([Android][and-sensor]); Core Motion gives "the unbiased rotation rate" ([Apple][apple-proc]); JSM ships auto-calibration **off** because it "will sometimes interpret slow and steady movement as the controller being held still" ([README][jsm-readme]) |
| Sensor rate assumed | "60-200 a second" ([`controller.html:109`][local-ctl]) | 60 Hz on both platforms | Chromium pumps at 60 Hz ([`device_sensor_event_pump.h`][cr-pumph]) and caps Generic Sensor at 60 Hz ([`sensor_traits.h`][cr-traits]); WebKit sets 1/60 s ([`WebCoreMotionManager.h`][wk-wcmmh]) |
| Send rate | ≤ 30 Hz ([`controller.js:20`][local-ctrljs]) | One slim aim packet per sensor event (60 Hz) through `controller.send`, which is not throttled: `{ yaw, pitch, yawRate, pitchRate, t, n }` | Relay allows 90 messages/s per phone ([`rooms.mjs:51`][local-rooms]) |
| TV playout | Burst spread over 30 ms ([`game.js:45`][local-game]) | None. Draw the sight at `angle + rate × age`, `age` = now − packet time through the clock sync we already have; cap `age` at about 50 ms | Browsers do the same for pointers: predicted events exist "to reduce perceived latency" ([Pointer Events][pe-spec]). The 50 ms cap is **[U]** |
| Re-centre | Centre target at round start; RECENTER; button | Keep all three. Add a centre "start" target between waves, at most 20 s apart. Add a hold-to-freeze thumb zone. | Yaw drift 1-2°/min ([RoNIN][ronin] **[S]**) is 17-33 px per 20 s at 50 px/°, inside one target (radius 46 + slack 16, [`game.js:63`][local-game]). Freeze = JSM's `GYRO_OFF`, "a really important feature" ([README][jsm-readme]) |
| Aim assist | Sight slows to 0.6× over a target ([`blaster.js:243-244`][local-blaster]) | No slowdown. Make the hit area bigger instead: start at 1.4× the drawn radius (now 1.35×: 62/46) and give the shot to the nearest target inside it | Area cursors, target gravity and sticky targets are the studied options ([Bateman et al. 2011][bateman] **[S]**). The 1.4× is **[U]**. A slowdown breaks the angle-to-pixel mapping (see defect 7) |
| Shot timing | Targets rewound to trigger time, up to 0.3 s | Keep. Also try taking the sight position from 50-80 ms before the tap | Tapping moves the phone. Selection-induced error is documented for tracked controllers ([Wolf et al. 2020][wolf] **[U]**, not fetched) |
| Latency target | not stated | Added delay before the display under about 55 ms; never over 110 ms | 55 ms is the noticeable difference for indirect dragging ([Deber et al. 2015][deber] **[S]**); errors "increase very quickly" past 110 ms and with jitter over 40 ms ([Pavlovych & Stuerzlinger][pavlovych] **[S]**) |
| Transport | WebSocket through the relay | Measure first (Bench, "Round trip"). If one way is over about 30 ms, add a WebRTC DataChannel `{ ordered: false, maxRetransmits: 0 }` phone to TV, relay as fallback | [WebRTC spec][webrtc-spec]. The 30 ms trigger is **[U]** |

---

## Defects in the current code

Ordered by how much each one hurts. Each names the source it departs from, or says it is a plain bug.

1. **Gyro axes in the wrong order.** [`controller.html:170`][local-ctl] reads `[alpha, beta, gamma]`; [`:227`][local-ctl] documents them as z, x, y; [`:242`][local-ctl] takes `w[0]` as z and [`:243`][local-ctl] takes `w[1], w[2]` as x, y. The spec and both engines give x, y, z ([spec][do-spec], [Chromium][cr-pump], [WebKit][wk-wcmm]). Should be `[wx, wy] = toScreen(w[0], w[1]); wz = w[2]`. The same wrong order feeds the join-page path (the relay's [`shell.js:346`][local-shell] only forwards the three numbers, so the fix belongs here). Every gyro feature inherits it; swings only use the size of the turn, which is why they looked fine.
2. **Pitch axis comes from the screen, not from how the phone is held.** [`controller.html:264`][local-ctl] sets `pitch = wx`, screen x, which [`:180-185`][local-ctl] and [`:200`][local-ctl] derive from `screen.orientation.angle`. With rotation lock on, the page stays portrait while the phone is held sideways, the angle is 0, screen x is the phone's short side, and that side is vertical. So even with defect 1 fixed, "pitch" would measure turning left/right. The spec says the device axes never turn with the screen ([spec][do-spec]), so the screen angle tells you about the page, not the hand. Take the pitch axis from gravity (see the numbers table).
3. **`screen.orientation.lock('portrait')` asks for the broken case.** [`controller.html:176`][local-ctl]. In our sandboxed frame it always fails: a sandboxed document without `allow-orientation-lock` gets `SecurityError`, and locking normally needs fullscreen first ([Screen Orientation][so-spec]; frame sandbox is `allow-scripts` only, [`shell.js:239`][local-shell]). Safari has no `lock()` at all ([BCD][bcd-so]). So whether the page turns depends on each player's auto-rotate setting, and the code has two paths in the wild. If the lock ever did succeed, it would force the angle-0 path of defect 2.
4. **"Up" silently falls back to a made-up pose.** `pm.ori` starts at beta 35°, gamma 0 ([`controller.html:103`, `:124`][local-ctl]) and only changes when an orientation reading arrives ([`:201`][local-ctl]); [`:209-212`][local-ctl] build "up" from it. If `deviceorientation` is late or absent, yaw is measured about the wrong axis for a sideways phone. Gravity is available in the same motion event (`accelerationIncludingGravity − acceleration`), with the same timestamp.
5. **A long delay chain before the network.** Up to 17 ms for the 60 Hz sensor tick ([Chromium][cr-pumph], [WebKit][wk-wcmmh]); 0-33 ms waiting for the send slot ([`controller.js:20`][local-ctrljs]); about 25 ms from the 4-sample average on slow moves ([`controller.html:271-276`][local-ctl]); up to one frame because the TV polls `party.inputs` once per frame ([`motion.js:216-217`][local-motion]); 30 ms mean from the exponential playout ([`motion.js:264`][local-motion], [`game.js:45`][local-game]); on iOS another 0-16 ms in the join page's timer ([`shell.js:315`][local-shell]). On average that is roughly 60-95 ms before the network (50-150 ms by our own estimate, [`DESIGN.md:163`][local-design]) and the TV. Past 110 ms errors climb fast ([Pavlovych & Stuerzlinger][pavlovych] **[S]**); at 225 ms movement time rose 64% and errors 214% ([MacKenzie & Ware 1993][mackenzie] **[S]**).
6. **Smoothing reaches too fast and is measured in samples.** [`controller.html:272`][local-ctl] keeps 4 samples whatever the rate; [`game.js:54`][local-game] smooths up to 12°/s, which is a sight moving 600 px/s. JoyShockMapper: none above a "very small threshold" (5°/s in its 2D sample), over a fixed time ([README][jsm-readme], [`_2Dmouse.txt`][jsm-2d]).
7. **The sticky slowdown shifts the aim every time the sight crosses a target.** [`blaster.js:243-244`][local-blaster] multiplies the movement by 0.6 over a target. The slow zone is 1.1 × the radius, about 101 px wide for a normal target. Stopping on its centre drops about 34 px (0.7°) of real turning; crossing it drops about 67 px (1.3°), in whichever direction the hand was moving. To the player that is drift. GyroWiki's line is "You don't have aim assist with a mouse, so don't do it with gyro" ([GyroWiki][gyrowiki-1] **[S]**).
8. **Tightening throws real motion away with nothing to bring it back.** [`controller.html:266-270`][local-ctl] scales down anything under 1.5°/s. In a pure rate design each slow correction slips the aim a little; JSM's author treats it as a last resort ([README][jsm-readme]). With an anchor the lost motion returns.
9. **Edge clamping re-bases the aim.** [`blaster.js:110-114`][local-blaster] drops turning past the edge "to soak up drift". It also means one overshoot leaves the sight offset from the phone by the overshoot. With an absolute mapping, clamping is only a display limit and coming back restores the aim.
10. **Different px/° on the two axes, and a borrowed setting.** `pxX` 50, `pxY` 55 ([`game.js:63`][local-game]) bend diagonal moves by 10%. [`blaster.js:106-108`][local-blaster] scales aim by `tiltSensitivity`, the Marble Maze setting ([`game.js:151`][local-game]), so tuning the maze changes the gun.
11. **Gyro bias learned twice.** [`controller.html:239-240`][local-ctl]. The OS already does it ([Android][and-sensor], [Apple][apple-proc]), and JSM warns that automatic calibration mistakes a slow steady aim for stillness ([README][jsm-readme]). The cap also means a phone whose raw rate at rest is 1.5°/s or more never calibrates (the test on line 239 uses the uncorrected rate).
12. **Setting the aim does not clear turning already in flight.** [`blaster.js:183-186`][local-blaster] centres the sight, but `gyroOwed` in [`motion.js:260-268`][local-motion] keeps paying out the last burst. A few pixels, in a random direction, at the one moment that defines the aim.
13. **Nothing tests the phone engine.** [`tests/motion.test.js:56-68`][local-tests] and [`tests/blaster.test.js`][local-tests] feed ready-made `gx`/`gy` totals or deltas, so defects 1-4 cannot fail a test. [`DESIGN.md:137`][local-design] already lists this as a known gap.
14. **Wrong figure in a comment.** [`controller.html:109`][local-ctl] says 60-200 events a second; both engines deliver 60 ([Chromium][cr-pumph], [WebKit][wk-wcmmh]). Swing timing "to the millisecond" rests on the same assumption.

Not a defect, but new: Chrome 152 adds `DeviceMotionEvent.requestPermission()` ([BCD][bcd-dme], [Chromium][cr-dmc]). The join page shows its "Allow motion controls" button whenever that function exists ([`shell.js:283`][local-shell]), so Android players on current Chrome now get the button too.

---

## Findings by topic

### 1. Browser sensor facts

- **Axes.** x to the right of the screen, y to its top, z out of it, defined for the screen's *standard* orientation; "if the orientation of the screen changes … this does not affect the orientation of the coordinate frame relative to the device" ([spec][do-spec]). Rotation rates are in deg/s, right-handed ([spec][do-spec]).
- **`rotationRate`.** `alpha`/`beta`/`gamma` are the x/y/z rates (see the headline finding).
- **`interval`.** "The interval at which data is obtained from the underlying hardware", in milliseconds, and constant ([spec][do-spec]). Chromium reports the 60 Hz pump delay, about 16 ([`device_motion_event_pump.cc`][cr-pump], [`.h`][cr-pumph]). WebKit passes 1/60, a value in seconds ([`DeviceMotionClientIOS.mm` line 126][wk-dmci], [`WebCoreMotionManager.h`][wk-wcmmh]). Do not use it across browsers; time the samples yourself, as we do.
- **Real rates.** Chrome Android: `devicemotion` and `deviceorientation` fire from a 60 Hz timer that reads the latest sensor value ([`device_sensor_event_pump.h`][cr-pumph], [`device_motion_event_pump.cc`][cr-pump]); Generic Sensor classes are capped at 60 Hz ([`sensor_traits.h`][cr-traits], [`sensor.cc`][cr-sensor]). iOS Safari: 60 Hz ([`WebCoreMotionManager.h`][wk-wcmmh]). The Generic Sensor spec says the cap "prevents use cases which rely on low latency or high data density" and accepts that ([Generic Sensor][gs-spec]).
- **Precision.** Orientation is limited to 0.1°, rates to 0.1°/s, acceleration to 0.1 m/s² ([spec][do-spec]; Chromium's constants [`platform_sensor_util.h`][cr-util]). The quaternion from the Generic Sensor classes is rounded to 0.1° too ([`platform_sensor_util.cc`][cr-util]).
- **Relative or absolute.** `deviceorientation` gives relative orientation (accelerometer and gyroscope, arbitrary reference) and may fall back to absolute; `deviceorientationabsolute` adds the magnetometer ([spec][do-spec]). Chromium asks for the relative sensor first and falls back to absolute only if it cannot connect ([`device_orientation_event_pump.cc`][cr-ori]); Chrome has given relative values since version 50 ([BCD note][bcd-doe]). On Android the relative quaternion is `TYPE_GAME_ROTATION_VECTOR` ([`PlatformSensorProvider.java`][cr-psp]). WebKit starts Core Motion with its default reference frame ([`WebCoreMotionManager.mm` line 174][wk-wcmm]), which is `xArbitraryZVertical`: z vertical, x arbitrary, no magnetometer ([Apple][apple-proc], [Apple][apple-xarb]).
- **Generic Sensor API.** `Gyroscope` (rad/s) and `RelativeOrientationSensor` (quaternion) exist in Chrome since 67 and not in Safari or Firefox ([BCD Gyroscope][bcd-gyro], [BCD RelativeOrientationSensor][bcd-ros]). They take `referenceFrame: "screen"`, which re-expresses readings in screen axes for you ([Gyroscope][gyro-spec], [Orientation Sensor][os-spec]). That option would repeat defect 2: it follows the page, not the hand.
- **Is the OS's fused orientation better than integrating `rotationRate` ourselves?** Yes for pitch and roll, no for yaw. The OS does its fusing before the browser samples at 60 Hz and rounds to 0.1°/s, and it corrects against gravity; we would be integrating 60 rounded samples a second. (How fast the OS fuses internally is **[U]**.) Android says of the game rotation vector that "relative rotations are more accurate" than the magnetometer-based one, but its reference "is allowed to drift by the same order of magnitude as the gyroscope drifts around the Z axis" ([Android][and-pos]). The Orientation Sensor spec says the same of the relative sensor: "may drift over time" ([Orientation Sensor][os-spec]). The new Generic Sensor classes bring nothing here that `deviceorientation` lacks: same sensor, same 60 Hz, same 0.1° rounding, and no iOS.
- **Permission.** The spec requires `requestPermission()` with transient activation (a tap) ([spec][do-spec]). iOS Safari has it ([BCD][bcd-dme]) and rejects a call without a user gesture ([WebKit `DeviceMotionEvent.cpp`][wk-dme]); a frame of another origin does not inherit the top page's grant ([WebKit access controller][wk-doamac]), which is why the join page asks and relays. Chrome has the method from 152 and maps it to its sensors permission ([BCD][bcd-dme], [Chromium][cr-dmc]).
- **Cross-origin frames.** The events need the `accelerometer` and `gyroscope` policy features, default allowlist `'self'` ([spec][do-spec]); our frame has them ([`shell.js:240`][local-shell]). A sandboxed frame without `allow-same-origin` has an opaque origin for policy purposes ([Permissions Policy, "declared origin"][pp-spec]).
- **Focus.** Sensor readings go only to a document that passes the "focus and origin check" ([Generic Sensor][gs-spec]). Chromium suspends a frame's sensors unless it is the focused frame or same-origin with it ([`sensor_proxy.cc` lines 97-120][cr-proxy]). Our frame's origin is opaque, so it is never same-origin with the join page. That is the mechanism behind "Android only sends events to the focused frame" in `DESIGN.md`.
- **Screen orientation.** See defects 2 and 3. `lock()` needs the frame not to be sandboxed against it and usually fullscreen ([Screen Orientation][so-spec]).

### 2. Gyro aiming best practice

GyroWiki could not be opened; JoyShockMapper's README and code are by the same author and were read directly.

- **Principle.** "The gyro is a mouse" ([GyroWiki, Good Gyro Controls part 1][gyrowiki-1] **[S]**). Valve says the same from the other side: good gyro aim needs 1:1 mouse-style data, which stick curves and deadzones destroy ([Steamworks, Steam Deck recommendations][valve] **[S]**).
- **Sensitivity in real-world units.** `GYRO_SENS` 1 means the game turns as far as the controller. For an on-screen cursor, 1 is a full turn of the controller across the screen and "you'll be better off with … 8 or more" (45° across) ([README][jsm-readme]). The shipped 2D sample runs 8 to 16 depending on speed ([`_2Dmouse.txt`][jsm-2d]). Ours is 14.
- **What not to do.** No minimum-speed cutoff ("never good"); no smoothing above a very small threshold, because smoothing "unavoidably introduces latency"; no mouse acceleration when 1:1 matters; automatic calibration off by default ([README][jsm-readme]).
- **What is allowed, sparingly.** Tightening (`GYRO_CUTOFF_RECOVERY`) and soft tiered smoothing: full below half the threshold, none above it, over `GYRO_SMOOTH_TIME` 0.125 s ([README][jsm-readme]). GyroWiki's own pages describe the same two functions ([Tight and Smooth][gyrowiki-smooth] **[S]**).
- **Which axis is "left/right".** Local space uses fixed controller axes. World space uses gravity as the yaw axis and derives the pitch axis by projecting onto the level plane. Player space keeps the controller's own pitch axis and takes yaw from gravity with a 1.41 "relax factor" so that gravity error cannot leak in ([README `GYRO_SPACE`][jsm-readme], [GamepadMotionHelpers lines 1169-1215][gmh], [GyroWiki][gyrowiki-space] **[S]**). All three assume the controller's pitch axis is known. A phone can be held either way round, so we need the world-space form, with the pitch axis from gravity.
- **Calibration.** Done by "leaving the controller still … and finding the average velocity"; a manual button is recommended over automatic ([README][jsm-readme]). The helper library's automatic mode needs at least 10 samples and 0.5 s of stillness ([GamepadMotionHelpers lines 195-213][gmh]). On a phone the OS has done this before we see the data ([Android][and-sensor], [Apple][apple-proc]).
- **Ratchet.** `GYRO_OFF` while a button is held, "just as a PC gamer can temporarily 'disable' the mouse by lifting it off the mousepad" ([README][jsm-readme]). Steam Input's gyro enable button is the same idea ([community guides only][valve] **[S]**, not confirmed in Valve's own text).

### 3. Pointer aiming with only an IMU

- **Every shipped IMU-only pointer I could trace is relative to the last re-centre and makes re-centring cheap.** Daydream's controller orientation is "relative to the last time the user recentered their controllers", with a system recenter gesture and a `Recentered` flag for apps ([`GvrControllerInput.cs`][daydream-input]). Its position is not tracked at all: an arm model guesses it from the rotation (elbow rest position, 0.6 of the rotation given to the elbow) ([`GvrArmModel.cs`][daydream-arm]). WebXR names the class: a 3DoF device "can only track rotational movement", poses carry `emulatedPosition`, and a `reset` event fires when the origin jumps ([WebXR][webxr-spec]).
- **Nintendo.** Skyward Sword's MotionPlus pointer and the Switch's Joy-Con pointer are described as gyro pointers with a button that puts the cursor back in the centre (D-pad down; `+` in World of Goo; `R` in Pikmin) ([secondary reports only][nintendo] **[S]**). Nintendo's own pages and the Iwata Asks text could not be opened, so treat this as **[U]** from first-party.
- **Sony.** Nothing primary found. **[U]**
- **Absolute orientation or rate integration?** They read the same gyro, so yaw drifts the same in both. Absolute orientation wins on three counts: pitch is anchored to gravity ([Apple][apple-xarb], [Android][and-pos]); the OS fuses before the browser's 60 Hz sampling and 0.1°/s rounding get in the way ([Chromium][cr-pumph], [spec][do-spec]); and the mapping holds no state, so clamps, filters and lost packets cannot build up an offset. Rate wins on smoothness, because orientation arrives in 0.1° steps ([Chromium][cr-util]). Use orientation as the anchor and rate as the fast path. This is what 1.7.0 described, and it is the right shape; what differs now is listed [below](#what-is-different-from-170).
- **Expected drift.** Pitch: none. Yaw: Android gives no number, only "the same order of magnitude as the gyroscope drifts around the Z axis" ([Android][and-sensor]). One benchmark reports Android's game rotation vector drifting "10 to 20 degrees over 10 minutes", so 1-2°/min ([RoNIN][ronin] **[S]**). The compatibility document only *recommends* a resting calibration error under 0.01 rad/s (0.57°/s), which is a loose ceiling, not a typical value ([Android CDD §7.3.4][cdd] **[S]**). iOS: no figure; Apple offers a magnetometer-corrected frame "to improve long-term accuracy for the z axis (yaw)" ([Apple][apple-xarbc]), which says the plain one drifts, and WebKit uses the plain one ([WebKit][wk-wcmm]). Our own note says "a few degrees a minute" ([`DESIGN.md:163`][local-design]).

### 4. Camera-based absolute aiming

- **It is how the one modern light gun does it.** Sinden: a camera in the barrel finds a white border the software draws around the picture and works out the aim from it; 60 fps camera; no sensor bar; no re-calibration when you move ([Sinden shop][sinden] **[S]**).
- **Permission and the frame.** `getUserMedia` needs a secure context and the `camera` feature, default allowlist `'self'` ([Media Capture and Streams][gum-spec]). Our frame's `allow` is `fullscreen; accelerometer; gyroscope` ([`shell.js:240`][local-shell]), so the camera is refused there today. Options: add `camera` to `allow` (a relay change in `pushplay`), or capture in the join page and post results in, the way iOS motion already works. How Chrome and Safari attribute a camera prompt to a sandboxed opaque-origin frame was not verified (**[U]**); capturing in the join page avoids the question.
- **Detectors.** `js-aruco2` is plain JavaScript and reads ArUco, AprilTag and other square-marker dictionaries from RGBA frames ([README][jsaruco2]); its README gives no timings. AR.js does marker tracking and gives no phone timings in its current README either ([README][arjs]). OpenCV's JavaScript build includes the ArUco detector ([`opencv_js.config.py`][ocv]). **No measured cost on phones was found in any primary source: [U].**
- **Shipping it.** The controller page reaches the phone through the relay in 12,000-character pieces at 96 KB/s ([`party.js:30-32`][local-party]), and the frame may load nothing from the network ([`shell.mjs:42-43`][local-shellmjs]). So the detector must be small enough to inline (a multi-megabyte OpenCV build is out), or live in the join page as a kit feature.
- **Camera timing.** `requestVideoFrameCallback` gives per-frame metadata and exists in Chrome 83+ and Safari 15.4+ ([BCD][bcd-rvfc]). Camera-to-JavaScript delay on phones: nothing primary found, **[U]**.
- **Practical problems no spec covers.** The lens sits at one end of the phone, exactly where a hand goes in a two-handed sideways grip. The TV must show markers or a border all the time. A second player's arm blocks the view. All **[U]**: reasoning, not sources.
- **Verdict.** Not practical as the default for a casual party game. It adds a camera prompt to joining, needs changes in two repos, and its speed on real phones is unknown. It is worth one later experiment in a narrower role: a fix every few hundred milliseconds that removes yaw drift from the IMU pointer, so players never re-centre. In that role frame rate and camera delay stop mattering.

### 5. Latency

- **How much is too much.** At 225 ms of lag, movement time rose 64% and errors 214% against 8.3 ms; lags tested were 8.3, 25, 75 and 225 ms ([MacKenzie & Ware 1993][mackenzie] **[S]**, abstract figures). Latency hurts more than small amounts of jitter ([Pavlovych & Stuerzlinger 2009][pavlovych09] **[S]**). In target following, errors "increase very quickly for latencies of over 110 ms, for latency jitters above 40 ms" ([Pavlovych & Stuerzlinger][pavlovych] **[S]**). People notice a latency difference of about 55 ms when dragging on an indirect device ([Deber et al. 2015][deber] **[S]**, figure from papers citing it).
- **Where ours goes.** See defect 5: about 60-95 ms before the network and the TV.
- **Relay or direct.** Our messages go phone → relay → TV over WebSocket ([`shell.js:151`][local-shell], [`party.js`][local-party]). The game already measures the round trip ([`motion.js:326-341`][local-motion]) and the Bench shows it. A WebRTC DataChannel can be unordered (`ordered: false`) and give up on lost packets (`maxRetransmits: 0`) ([WebRTC][webrtc-spec]); our running totals plus a sequence number suit that. No primary measurement comparing the two was found: **[U]**. Measure ours before building anything.
- **Hiding delay.** Send at the sensor rate (60 Hz, cap 90/s: [`rooms.mjs:51`][local-rooms]). Extrapolate the sight by angular velocity for the packet's age; browsers expose the same trick for pointers ([Pointer Events, predicted events][pe-spec]). Keep judging shots at trigger time, which we already do ([`blaster.js:269`][local-blaster]).

### 6. Aim assist for a light gun

- No first-party document from a light-gun or shooting-gallery game was found. **[U]**
- Research names three families for 2D aiming: area cursors (a bigger effective hit area), target gravity (pull) and sticky targets (slowdown), and reports that weaker players enjoyed the game more with them ([Bateman et al. 2011][bateman] **[S]**). For first-person shooters the same group found mixed results ([Vicencio-Moreira et al. 2014][vicencio] **[S]**, full text not read).
- For a pointer that should feel like pointing, only the first family leaves the mapping alone. That is the reason to enlarge hit areas and drop the slowdown (defect 7).

---

## Sketch of the recommended aim maths

Derived here from the spec's rotation order (Z, then X, then Y) and its own worked example for "a vector which is orthogonal to the device's screen and pointing out of the back of the screen" ([spec, appendix][do-spec]). Signs need one check on a phone.

```
// alpha, beta, gamma from deviceorientation, in radians. f = where the back of the phone points.
fx = -cos(alpha) * sin(gamma) - sin(alpha) * sin(beta) * cos(gamma)
fy = -sin(alpha) * sin(gamma) + cos(alpha) * sin(beta) * cos(gamma)
fz = -cos(beta) * cos(gamma)
yaw   = atan2(fy, fx) * 180 / PI   // heading of the aim, degrees; relative, drifts slowly
pitch = asin(fz) * 180 / PI        // elevation of the aim, degrees; tied to gravity, does not drift

// rates from devicemotion, real axis order: w = [alpha, beta, gamma] = [x, y, z] in deg/s
up    = [-sin(gamma) * cos(beta), sin(beta), cos(gamma) * cos(beta)]   // as controller.html:211-212, before toScreen
right = normalize([up[1], -up[0], 0])                                  // level axis across the aim
yawRate   = dot(w, up)       // turning left is positive
pitchRate = dot(w, right)    // aim rising is positive

// each sample (dt in seconds, angles in degrees): fast path, then pull to the anchor
aim.yaw   += yawRate * dt;    aim.yaw   += wrap(yaw - aim.yaw) * (1 - exp(-dt / 0.3))
aim.pitch += pitchRate * dt;  aim.pitch += (pitch - aim.pitch) * (1 - exp(-dt / 0.3))

// TV: sight = centre + pxPerDeg * (-(wrap(aim.yaw - zero.yaw)), -(aim.pitch - zero.pitch))
```

`right` is undefined when the phone lies flat (the back points at the floor); a gun pointed at a TV never does. Re-centre sets `zero` to the current `aim`. The fallback gyro-mouse is the same code with the two "pull" terms removed.

---

## What is different from 1.7.0

1.7.0 pointed by orientation, used the gyro between readings and pulled the sight back to the pointing. The recommendation has the same shape. The differences:

1. **The gyro term was wrong then** (defects 1 and 2), so the fast path pushed the sight the wrong way and the anchor dragged it back.
2. **Delay.** One packet per sensor event instead of 30 Hz, no playout smoothing, extrapolation by rate, and a direct connection if the relay proves slow.
3. **Drift is budgeted, not denied.** 1-2°/min of yaw against a 62 px hit radius gives about 20 s between re-centres; the game supplies them as wave-start targets.
4. **Forgiveness that does not move the aim.** Bigger hit areas, no slowdown.
5. **Sensitivity fitted to the room** by two shots, where 1.7.1 retuned a constant by feel.
6. **It gets tested on a phone** before anyone concludes anything.

It still is not true line of sight: a phone cannot know where the TV is without a camera. 1.8.0 was right about that.

---

## Open questions only a real phone can settle

1. Does the axis check pass (flat spin moves `rotationRate.gamma`) on the owner's Android phone and on an iPhone?
2. After fixing defects 1 and 2 only, with nothing else changed, does Blaster Range already feel acceptable?
3. What does the Bench show for round trip, and where is the relay hosted relative to the players? This decides whether WebRTC is worth building.
4. How fast does yaw really drift on these phones, held and aiming, over a 60 s round? (Aim at the centre target, play, aim at it again, read the offset.)
5. Does `deviceorientation` reach the frame on Android at 60 Hz the whole round, or does focus loss stall it?
6. Is `alpha` continuous on iOS when the phone is held sideways and upright, and does it jump when Safari re-prompts or the page is backgrounded?
7. Do 0.1° steps show as jitter at 50 px/°, and which hides them better: the 0.3 s anchor or a One Euro filter?
8. How much does a thumb tap move the aim, and does sampling the sight 50-80 ms earlier fix it?
9. Is 25.6° across right for the owner's sofa and TV, or does the two-shot calibration give something very different?
10. How much does the TV itself add? (Game mode on and off.)
11. Do `connect-src` rules on the join page and the frame block `RTCPeerConnection`? ([`shell.mjs:42-45`][local-shellmjs])
12. Only if the camera experiment goes ahead: marker detection time per frame on a mid-range Android phone, and whether the grip covers the lens.

---

## Sources

### Project code [D]

- [local-ctl] `controller.html` in this repo
- [local-ctrljs] `controller.js` in this repo
- [local-motion] `motion.js` in this repo
- [local-game] `game.js` in this repo
- [local-blaster] `stations/blaster.js` in this repo
- [local-party] `party.js` in this repo
- [local-tests] `tests/` in this repo
- [local-design] `DESIGN.md` in this repo
- [local-180] `git show eae34b1:controller.html` (the 1.8.0 tree; the link opens the current file)
- [local-shell] `apps/relay/public/shell.js` in `Visual-Zone-Development/pushplay` (private repo, read from the local checkout)
- [local-shellmjs] `apps/relay/src/shell.mjs` in `Visual-Zone-Development/pushplay`
- [local-rooms] `apps/relay/src/rooms.mjs` in `Visual-Zone-Development/pushplay`

### Specs, read from their source files [D]

- [do-spec] Device Orientation and Motion, editor's draft source. Rendered at <https://w3c.github.io/deviceorientation/>.
- [gs-spec] Generic Sensor API. Rendered at <https://w3c.github.io/sensors/>.
- [os-spec] Orientation Sensor. Rendered at <https://w3c.github.io/orientation-sensor/>.
- [gyro-spec] Gyroscope. Rendered at <https://w3c.github.io/gyroscope/>.
- [pp-spec] Permissions Policy. Rendered at <https://w3c.github.io/webappsec-permissions-policy/>.
- [so-spec] Screen Orientation. Rendered at <https://w3c.github.io/screen-orientation/>.
- [gum-spec] Media Capture and Streams. Rendered at <https://w3c.github.io/mediacapture-main/>.
- [webrtc-spec] WebRTC. Rendered at <https://w3c.github.io/webrtc-pc/>.
- [pe-spec] Pointer Events. Rendered at <https://w3c.github.io/pointerevents/>.
- [webxr-spec] WebXR Device API. Rendered at <https://immersive-web.github.io/webxr/>.

### Browser engine source [D]

- [cr-pump] Chromium `device_motion_event_pump.cc`
- [cr-pumph] Chromium `device_sensor_event_pump.h`
- [cr-rr] Chromium `device_motion_event_rotation_rate.h`
- [cr-ori] Chromium `device_orientation_event_pump.cc`
- [cr-dmc] Chromium `device_motion_controller.cc`
- [cr-traits] Chromium `sensor_traits.h`
- [cr-sensor] Chromium `sensor.cc`
- [cr-proxy] Chromium `sensor_proxy.cc`
- [cr-util] Chromium `platform_sensor_util.h` (and `.cc` beside it)
- [cr-psp] Chromium `PlatformSensorProvider.java`
- [wk-wcmm] WebKit `WebCoreMotionManager.mm`
- [wk-wcmmh] WebKit `WebCoreMotionManager.h`
- [wk-dmci] WebKit `DeviceMotionClientIOS.mm`
- [wk-dmd] WebKit `DeviceMotionData.h`
- [wk-dme] WebKit `DeviceMotionEvent.cpp`
- [wk-doamac] WebKit `DeviceOrientationAndMotionAccessController.cpp`

### Official documentation [D]

- [mdn-rr], [mdn-alpha] MDN pages, read from the `mdn/content` source
- [bcd-dme], [bcd-doe], [bcd-gyro], [bcd-ros], [bcd-so], [bcd-gum], [bcd-rvfc] MDN browser-compat-data
- [and-pos], [and-sensor] Android developer documentation
- [apple-proc], [apple-xarb], [apple-xarbc] Apple Core Motion documentation

### Gyro aiming [D] unless marked

- [jsm-readme] JoyShockMapper README (current fork; the original at <https://github.com/JibbSmart/JoyShockMapper> has the same gyro text)
- [jsm-2d] JoyShockMapper `GyroConfigs/_2Dmouse.txt`
- [gmh] GamepadMotionHelpers `GamepadMotion.hpp`
- [gyrowiki-1], [gyrowiki-smooth], [gyrowiki-space] GyroWiki **[S]**
- [valve] Steamworks documentation **[S]**

### Pointer products

- [daydream-input], [daydream-arm] Google VR SDK for Unity **[D]**
- [nintendo] Secondary reports of Nintendo's gyro pointers (a fan transcription of Iwata Asks, a press review, a fan wiki) **[S]**; first-party **[U]**
- [sinden] Sinden shop **[S]**

### Camera libraries [D]

- [jsaruco2] js-aruco2 README
- [arjs] AR.js README
- [ocv] OpenCV JavaScript build configuration

### Filtering

- [oneeuro] 1€ filter, authors' repository **[D]**
- [oneeuro-tune] 1€ filter tuning procedure, authors' Arduino library **[S]**

### Papers, all [S] unless marked

- [mackenzie] MacKenzie & Ware, "Lag as a determinant of human performance in interactive systems", INTERCHI 1993
- [pavlovych09] Pavlovych & Stuerzlinger, "The tradeoff between spatial jitter and latency in pointing tasks", EICS 2009
- [pavlovych] Pavlovych & Stuerzlinger, "Target following performance in the presence of latency, jitter, and signal dropouts", 2011
- [deber] Deber, Jota, Forlines & Wigdor, "How much faster is fast enough?", CHI 2015
- [bateman] Bateman, Mandryk, Stach & Gutwin, "Target assistance for subtly balancing competitive play", CHI 2011
- [vicencio] Vicencio-Moreira, Mandryk, Gutwin & Bateman, "The effectiveness (or lack thereof) of aim-assist techniques in first-person shooter games", CHI 2014
- [ronin] Herath, Yan & Furukawa, "RoNIN: Robust Neural Inertial Navigation in the Wild", 2019
- [wolf] Wolf, Gugenheimer, Combosch & Rukzio, "Understanding the Heisenberg Effect of Spatial Interaction", CHI 2020 **[U]** (cited from memory, not fetched)
- [w3c-list] W3C public-geolocation list, August 2017
- [cdd] Android Compatibility Definition, §7.3.4

### Sites that could not be fetched

Refused by this sandbox's network rules when tried: `www.w3.org`, `w3c.github.io`, `gyrowiki.jibbsmart.com`, `developer.mozilla.org`, `partner.steamgames.com`, `source.android.com`, `developer.chrome.com`, `web.dev`, `webkit.org`, `www.sindenlightgun.com`, `sindenwiki.org`, `www.yorku.ca`, `dl.acm.org`, `arxiv.org`, `www.rfc-editor.org`, `docs.opencv.org`, `www.nintendo.com`, `iwataasks.nintendo.com`, `immersive-web.github.io`. GitHub's file browser also refused, so only files whose path I knew could be read. Everything marked **[S]** should be re-read at its link once those hosts are allowed. GyroWiki matters most: its numbers here come from JoyShockMapper, by the same author.

[local-ctl]: ../../controller.html
[local-ctrljs]: ../../controller.js
[local-motion]: ../../motion.js
[local-game]: ../../game.js
[local-blaster]: ../../stations/blaster.js
[local-party]: ../../party.js
[local-tests]: ../../tests/
[local-design]: ../../DESIGN.md
[local-180]: ../../controller.html
[local-shell]: https://github.com/Visual-Zone-Development/pushplay/blob/main/apps/relay/public/shell.js
[local-shellmjs]: https://github.com/Visual-Zone-Development/pushplay/blob/main/apps/relay/src/shell.mjs
[local-rooms]: https://github.com/Visual-Zone-Development/pushplay/blob/main/apps/relay/src/rooms.mjs
[do-spec]: https://github.com/w3c/deviceorientation/blob/main/index.bs
[gs-spec]: https://github.com/w3c/sensors/blob/main/index.bs
[os-spec]: https://github.com/w3c/orientation-sensor/blob/main/index.bs
[gyro-spec]: https://github.com/w3c/gyroscope/blob/main/index.bs
[pp-spec]: https://github.com/w3c/webappsec-permissions-policy/blob/main/index.bs
[so-spec]: https://github.com/w3c/screen-orientation/blob/gh-pages/index.html
[gum-spec]: https://github.com/w3c/mediacapture-main/blob/main/getusermedia.html
[webrtc-spec]: https://github.com/w3c/webrtc-pc/blob/main/webrtc.html
[pe-spec]: https://github.com/w3c/pointerevents/blob/gh-pages/index.html
[webxr-spec]: https://github.com/immersive-web/webxr/blob/main/index.bs
[cr-pump]: https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/device_orientation/device_motion_event_pump.cc
[cr-pumph]: https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/device_orientation/device_sensor_event_pump.h
[cr-rr]: https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/device_orientation/device_motion_event_rotation_rate.h
[cr-ori]: https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/device_orientation/device_orientation_event_pump.cc
[cr-dmc]: https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/device_orientation/device_motion_controller.cc
[cr-traits]: https://github.com/chromium/chromium/blob/main/services/device/public/cpp/generic_sensor/sensor_traits.h
[cr-sensor]: https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/sensor/sensor.cc
[cr-proxy]: https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/sensor/sensor_proxy.cc
[cr-util]: https://github.com/chromium/chromium/blob/main/services/device/generic_sensor/platform_sensor_util.h
[cr-psp]: https://github.com/chromium/chromium/blob/main/services/device/generic_sensor/android/java/src/org/chromium/device/sensors/PlatformSensorProvider.java
[wk-wcmm]: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/ios/WebCoreMotionManager.mm
[wk-wcmmh]: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/ios/WebCoreMotionManager.h
[wk-dmci]: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/ios/DeviceMotionClientIOS.mm
[wk-dmd]: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/DeviceMotionData.h
[wk-dme]: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/DeviceMotionEvent.cpp
[wk-doamac]: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/DeviceOrientationAndMotionAccessController.cpp
[mdn-rr]: https://github.com/mdn/content/blob/main/files/en-us/web/api/devicemotionevent/rotationrate/index.md
[mdn-alpha]: https://github.com/mdn/content/blob/main/files/en-us/web/api/devicemotioneventrotationrate/alpha/index.md
[bcd-dme]: https://github.com/mdn/browser-compat-data/blob/main/api/DeviceMotionEvent.json
[bcd-doe]: https://github.com/mdn/browser-compat-data/blob/main/api/DeviceOrientationEvent.json
[bcd-gyro]: https://github.com/mdn/browser-compat-data/blob/main/api/Gyroscope.json
[bcd-ros]: https://github.com/mdn/browser-compat-data/blob/main/api/RelativeOrientationSensor.json
[bcd-so]: https://github.com/mdn/browser-compat-data/blob/main/api/ScreenOrientation.json
[bcd-gum]: https://github.com/mdn/browser-compat-data/blob/main/api/MediaDevices.json
[bcd-rvfc]: https://github.com/mdn/browser-compat-data/blob/main/api/HTMLVideoElement.json
[and-pos]: https://developer.android.com/develop/sensors-and-location/sensors/sensors_position
[and-sensor]: https://developer.android.com/reference/android/hardware/Sensor
[apple-proc]: https://developer.apple.com/documentation/coremotion/getting-processed-device-motion-data
[apple-xarb]: https://developer.apple.com/documentation/coremotion/cmattitudereferenceframe/xarbitraryzvertical
[apple-xarbc]: https://developer.apple.com/documentation/coremotion/cmattitudereferenceframe/xarbitrarycorrectedzvertical
[jsm-readme]: https://github.com/Electronicks/JoyShockMapper/blob/master/README.md
[jsm-2d]: https://github.com/Electronicks/JoyShockMapper/blob/master/dist/GyroConfigs/_2Dmouse.txt
[gmh]: https://github.com/JibbSmart/GamepadMotionHelpers/blob/main/GamepadMotion.hpp
[gyrowiki-1]: https://gyrowiki.jibbsmart.com/blog:good-gyro-controls-part-1:the-gyro-is-a-mouse
[gyrowiki-smooth]: http://gyrowiki.jibbsmart.com/blog:tight-and-smooth:soft-tiered-smoothing
[gyrowiki-space]: http://gyrowiki.jibbsmart.com/blog:player-space-gyro-and-alternatives-explained
[valve]: https://partner.steamgames.com/doc/steamhardware/recommendations
[daydream-input]: https://github.com/googlevr/gvr-unity-sdk/blob/master/Assets/GoogleVR/Scripts/Controller/GvrControllerInput.cs
[daydream-arm]: https://github.com/googlevr/gvr-unity-sdk/blob/master/Assets/GoogleVR/Scripts/Controller/ArmModel/GvrArmModel.cs
[nintendo]: https://www.zeldadungeon.net/wiki/Interview:Iwata_Asks:_Skyward_Sword_(2010)
[sinden]: https://www.sindenshop.com/en-us/pages/information-about-the-sinden-lightgun
[jsaruco2]: https://github.com/damianofalcioni/js-aruco2/blob/master/README.md
[arjs]: https://github.com/AR-js-org/AR.js/blob/master/README.md
[ocv]: https://github.com/opencv/opencv/blob/4.x/platforms/js/opencv_js.config.py
[oneeuro]: https://github.com/casiez/OneEuroFilter
[oneeuro-tune]: https://github.com/casiez/OneEuroFilterArduino
[mackenzie]: https://www.yorku.ca/mack/CHI93b.html
[pavlovych09]: https://vvise.iat.sfu.ca/pubs/pavlovych2009tradeoff
[pavlovych]: https://www.semanticscholar.org/paper/Target-following-performance-in-the-presence-of-and-Pavlovych-Stuerzlinger/958e49768f7d9df2f03560a6d77b676330ca5689
[deber]: https://dl.acm.org/doi/10.1145/2702123.2702300
[bateman]: https://dl.acm.org/doi/10.1145/1978942.1979287
[vicencio]: https://dl.acm.org/doi/10.1145/2556288.2557308
[ronin]: https://arxiv.org/pdf/1905.12853
[wolf]: https://doi.org/10.1145/3313831.3376876
[w3c-list]: https://lists.w3.org/Archives/Public/public-geolocation/2017Aug/0000.html
[cdd]: https://android.googlesource.com/platform/compatibility/cdd/+/refs/heads/oreo-dev/7_hardware-compatibility/7_3_sensors.md
