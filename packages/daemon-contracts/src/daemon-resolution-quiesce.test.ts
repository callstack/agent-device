import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildDaemonLifecycleRequest,
  DAEMON_LIFECYCLE_COMMANDS,
  readDaemonLifecycleCensus,
  readDaemonLifecycleFence,
  readDaemonLifecycleMode,
  readDaemonOwnership,
} from './daemon-resolution.ts';

test('a census is read only when every count is a non-negative integer', () => {
  const census = {
    startingUp: false,
    inFlightRequests: 1,
    sessions: 0,
    repairSessions: 2,
    leases: 3,
  };
  assert.deepEqual(readDaemonLifecycleCensus({ reason: 'daemon-busy', ...census }), census);

  // 2 ** 53 is an integer `Number.isInteger` accepts and arithmetic on it gets wrong, so the census
  // reader has to be the one that refuses it.
  for (const malformed of [-1, 1.5, '1', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null]) {
    assert.equal(readDaemonLifecycleCensus({ ...census, leases: malformed }), undefined);
  }
  assert.equal(readDaemonLifecycleCensus({ sessions: 1 }), undefined);
  // Only a daemon that is starting up says so; an older one omits the field.
  assert.equal(readDaemonLifecycleCensus({ ...census, startingUp: true })?.startingUp, true);
  const { startingUp: _omitted, ...withoutStartingUp } = census;
  assert.equal(readDaemonLifecycleCensus(withoutStartingUp)?.startingUp, false);
  assert.equal(readDaemonLifecycleCensus({ ...census, startingUp: 'yes' }), undefined);
  assert.equal(readDaemonLifecycleCensus(undefined), undefined);
});

test('a fence names an integer pid and a start time or null, nothing else', () => {
  assert.deepEqual(readDaemonLifecycleFence({ pid: 7, processStartTime: 'Fri' }), {
    pid: 7,
    processStartTime: 'Fri',
  });
  assert.deepEqual(readDaemonLifecycleFence({ pid: 7, processStartTime: null }), {
    pid: 7,
    processStartTime: null,
  });
  assert.equal(readDaemonLifecycleFence({ pid: 7 }), undefined);
  assert.equal(readDaemonLifecycleFence({ pid: 7.5, processStartTime: null }), undefined);
  assert.equal(readDaemonLifecycleFence('7'), undefined);
});

test('both lifecycle requests carry one fence shape under the command of their mode', () => {
  const fence = { pid: 7, processStartTime: 'Fri Oct 17 09:00:00 2026' };
  for (const mode of ['quiesce', 'shutdown'] as const) {
    const request = buildDaemonLifecycleRequest({ mode, token: 't0ken', fence, requestId: 'r-1' });
    assert.equal(request.command, DAEMON_LIFECYCLE_COMMANDS[mode]);
    assert.deepEqual(request.input, fence);
    assert.equal(request.meta?.requestId, 'r-1');
    assert.equal(readDaemonLifecycleMode(request.command), mode);
  }
  // A request that is not one of the two is dispatched like any other command, including a name the
  // lookup would answer for through the object prototype.
  assert.equal(readDaemonLifecycleMode('open'), undefined);
  assert.equal(readDaemonLifecycleMode('toString'), undefined);
  assert.equal(readDaemonLifecycleMode('__proto__'), undefined);
});

test('ownership names who may end the process, and an older record is detached', () => {
  assert.equal(readDaemonOwnership('embedded'), 'embedded');
  assert.equal(readDaemonOwnership('detached'), 'detached');
  // An absent field is every record written before this field existed, and those are daemons that are
  // their own process.
  for (const absent of [undefined]) {
    assert.equal(readDaemonOwnership(absent), 'detached');
  }
  // Anything else is its own state: a caller that means to signal a pid reads `unknown` as a thing it
  // must not do, not as permission to treat the record like a detached daemon's.
  for (const unrecognized of [null, 'owned', 7, '', 'EMBEDDED', 2 ** 53]) {
    assert.equal(readDaemonOwnership(unrecognized), 'unknown', String(unrecognized));
  }
});
