// The safety gate: before the first motion with a phone, a round holds on the "Before you move"
// screen until that phone's player taps I'm ready (the phone sends { safe: true }), or until this
// machine skips it once it has been up long enough to be read. Each phone reads it once.
//
//   const gate = createSafetyGate({ min: 2.5 })
//   party.on('msg') with data.safe:      gate.read(from)
//   when a round starts:                  gate.hold(activePhoneId)   // true: show the screen
//   each frame while gate.held:           if (gate.update(dt, { skip, phone })) start the round
//   draw/publish while gate.held:         gate.t (seconds up), gate.canSkip

export function createSafetyGate({ min = 2.5 } = {}) {
  const safe = new Set()
  let held = null
  return {
    /** This phone has read the card. */
    read(id) {
      safe.add(id)
    },
    hasRead: (id) => safe.has(id),
    /** A round is starting with this phone (or none): hold it if the phone hasn't read the card. */
    hold(id) {
      held = id && !safe.has(id) ? { id, t: 0 } : null
      return Boolean(held)
    },
    get held() {
      return Boolean(held)
    },
    get t() {
      return held?.t ?? 0
    },
    get canSkip() {
      return Boolean(held) && held.t > min
    },
    /**
     * One frame while held. skip: A / Start now pressed here this frame. phone: the phone now in
     * control (another may have taken over). Returns true when the round may start.
     */
    update(dt, { skip = false, phone = held?.id } = {}) {
      if (!held) return true
      held.t += dt
      if (phone !== held.id) held = phone && !safe.has(phone) ? { id: phone, t: held.t } : null
      if (!held || safe.has(held.id) || (skip && held.t > min)) {
        held = null
        return true
      }
      return false
    }
  }
}
