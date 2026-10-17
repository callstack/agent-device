import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readDaemonQuiesceCensus, readDaemonQuiesceFence } from './daemon-resolution.ts';

test('a census is read only when every count is a non-negative integer', () => {
  const census = {
    startingUp: false,
    inFlightRequests: 1,
    sessions: 0,
    repairSessions: 2,
    leases: 3,
  };
  assert.deepEqual(readDaemonQuiesceCensus({ reason: 'daemon-busy', ...census }), census);

  for (const malformed of [-1, 1.5, '1', Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.equal(readDaemonQuiesceCensus({ ...census, leases: malformed }), undefined);
  }
  assert.equal(readDaemonQuiesceCensus({ sessions: 1 }), undefined);
  // Only a daemon that is starting up says so; an older one omits the field.
  assert.equal(readDaemonQuiesceCensus({ ...census, startingUp: true })?.startingUp, true);
  const { startingUp: _omitted, ...withoutStartingUp } = census;
  assert.equal(readDaemonQuiesceCensus(withoutStartingUp)?.startingUp, false);
  assert.equal(readDaemonQuiesceCensus({ ...census, startingUp: 'yes' }), undefined);
  assert.equal(readDaemonQuiesceCensus(undefined), undefined);
});

test('a fence names an integer pid and a start time or null, nothing else', () => {
  assert.deepEqual(readDaemonQuiesceFence({ pid: 7, processStartTime: 'Fri' }), {
    pid: 7,
    processStartTime: 'Fri',
  });
  assert.deepEqual(readDaemonQuiesceFence({ pid: 7, processStartTime: null }), {
    pid: 7,
    processStartTime: null,
  });
  assert.equal(readDaemonQuiesceFence({ pid: 7 }), undefined);
  assert.equal(readDaemonQuiesceFence({ pid: 7.5, processStartTime: null }), undefined);
  assert.equal(readDaemonQuiesceFence('7'), undefined);
});
