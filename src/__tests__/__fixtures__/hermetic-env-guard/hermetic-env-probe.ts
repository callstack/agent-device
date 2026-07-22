import { test } from 'vitest';
import assert from 'node:assert/strict';

// Run only by hermetic-env-guard.test.ts, which spawns vitest against this
// fixture with the daemon vars + a control var set in the child environment.
test('the wired setup scrubs ambient daemon env before the test runs', () => {
  // Control var the setup must NOT touch: proves the child truly inherited the
  // injected environment, so the two absences below are scrubbing — not a child
  // that never received the vars in the first place.
  assert.equal(process.env.HERMETIC_GUARD_CONTROL, 'present');
  assert.equal(process.env.AGENT_DEVICE_DAEMON_BASE_URL, undefined);
  assert.equal(process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN, undefined);
});
