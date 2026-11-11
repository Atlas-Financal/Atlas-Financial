'use strict';
// One archive session at a time, per process.
//
// The hosted archive's writer role has CONNECTION LIMIT 1 (docs/
// PRIVATE_PERIOD_HISTORY.md), so a read and a capture that overlap refuse each
// other with SQLSTATE 53300 and the second one reports history-store-unavailable.
// The read refresh and the capture offer are both triggered by the same served
// refresh, a millisecond apart, so without this gate they collided every time.
// Whoever holds the gate has the one session; anyone else skips this round and
// is offered again by the next trigger. No waiting, no queue, no timer.
function createGate() {
  let held = false;
  return Object.freeze({
    // Returns a release function, or null when the session is already in use.
    tryAcquire() {
      if (held) return null;
      held = true;
      let released = false;
      return () => { if (!released) { released = true; held = false; } };
    },
  });
}

module.exports = { create: createGate, shared: createGate() };
