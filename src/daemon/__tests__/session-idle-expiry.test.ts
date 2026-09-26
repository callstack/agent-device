import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  SESSION_IDLE_EXPIRY_ENV,
  buildIdleExpiryTombstone,
  idleDeadlineExceeded,
  isIdleExpirableSession,
  isSessionIdleExpired,
  lastActivityMs,
  resolveSessionIdleExpiryMs,
  sessionIdleDeadlineMs,
  sessionIdleExpiredError,
} from '../session-idle-expiry.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { SessionState } from '../session-state.ts';

const CLAIM = {
  deviceKey: 'ios:sim-1',
  ownerToken: 'token-1',
  ownerPid: 4242,
  ownerStartTime: null,
} as const;

function claimHoldingSession(overrides: Parameters<typeof makeIosSession>[1] = {}) {
  return makeIosSession('default', { deviceClaim: { ...CLAIM }, ...overrides });
}

test('resolveSessionIdleExpiryMs is off unless the env names a positive number', () => {
  assert.equal(resolveSessionIdleExpiryMs({}), 0);
  assert.equal(resolveSessionIdleExpiryMs({ [SESSION_IDLE_EXPIRY_ENV]: '' }), 0);
  assert.equal(resolveSessionIdleExpiryMs({ [SESSION_IDLE_EXPIRY_ENV]: '0' }), 0);
  assert.equal(resolveSessionIdleExpiryMs({ [SESSION_IDLE_EXPIRY_ENV]: '-1' }), 0);
  assert.equal(resolveSessionIdleExpiryMs({ [SESSION_IDLE_EXPIRY_ENV]: 'not-a-number' }), 0);
  assert.equal(resolveSessionIdleExpiryMs({ [SESSION_IDLE_EXPIRY_ENV]: '1500000' }), 1_500_000);
  // A fractional window is a real reading, and flooring keeps it positive rather than NaN.
  assert.equal(resolveSessionIdleExpiryMs({ [SESSION_IDLE_EXPIRY_ENV]: ' 1500.7 ' }), 1500);
  // Flooring must never round a positive opt-in into `0`, which is the other thing this env means:
  // a smaller unit than milliseconds is a request for the shortest window, not for off.
  assert.equal(resolveSessionIdleExpiryMs({ [SESSION_IDLE_EXPIRY_ENV]: '0.4' }), 1);
});

test('lastActivityMs falls back to createdAt so an abandoned open still expires', () => {
  const session = claimHoldingSession({ createdAt: 1_000 });
  assert.equal(lastActivityMs(session), 1_000);
  session.lastActivityAtMs = 5_000;
  assert.equal(lastActivityMs(session), 5_000);
});

test('only a claim-holding, unleased, unrecording session is idle-expirable', () => {
  // No claim: the session holds nothing another agent waits on.
  assert.equal(isIdleExpirableSession(makeIosSession('default')), false);
  // A remote lease owns this session's ownership and already has its own inactivity TTL (ADR 0007).
  assert.equal(
    isIdleExpirableSession(
      claimHoldingSession({
        lease: { leaseId: 'lease-1', tenantId: 'tenant-1', runId: 'run-1', expiresAt: 1 },
      }),
    ),
    false,
  );
  // A live recording is use happening on the device with no command in flight, which is exactly the
  // evidence the daemon-process reap also honors.
  const recording = claimHoldingSession();
  recording.screenRecording = makeTestScreenRecordingResource(recording);
  assert.equal(isIdleExpirableSession(recording), false);
  assert.equal(isIdleExpirableSession(claimHoldingSession()), true);
});

test('idleDeadlineExceeded measures from the last activity and never fires while off', () => {
  const session = claimHoldingSession({ createdAt: 0, lastActivityAtMs: 1_000 });
  assert.equal(idleDeadlineExceeded(session, 0, 10_000), false);
  assert.equal(idleDeadlineExceeded(session, 5_000, 5_999), false);
  assert.equal(idleDeadlineExceeded(session, 5_000, 6_000), true);
});

test('isSessionIdleExpired refuses a session the policy may not touch even past its deadline', () => {
  const expiredInTime = claimHoldingSession({ createdAt: 0 });
  assert.equal(isSessionIdleExpired(expiredInTime, 1_000, 5_000), true);
  assert.equal(
    isSessionIdleExpired(makeIosSession('default', { createdAt: 0 }), 1_000, 5_000),
    false,
  );
});

test('sessionIdleDeadlineMs arms nothing for a session that is not expirable', () => {
  assert.equal(sessionIdleDeadlineMs(claimHoldingSession({ createdAt: 1_000 }), 5_000), 6_000);
  assert.equal(sessionIdleDeadlineMs(makeIosSession('default'), 5_000), undefined);
  assert.equal(sessionIdleDeadlineMs(claimHoldingSession(), 0), undefined);
});

test('the expiry error keeps SESSION_NOT_FOUND and carries the reason, window, and device', () => {
  const tombstone = buildIdleExpiryTombstone('cwd:abc:default', {
    expiredAtMs: 1_000,
    idleExpiryMs: 1_500_000,
    deviceKey: 'ios:sim-1',
  });
  // The hour is asserted as a value, not imported from the module: the marker's life is a promise to
  // the agent that comes next, and a test that re-derives it from the code would accept any TTL.
  assert.equal(tombstone.expiresAt, 1_000 + 60 * 60_000);

  const error = sessionIdleExpiredError('cwd:abc:default', tombstone, 61_000);
  assert.equal(error.code, 'SESSION_NOT_FOUND');
  assert.equal(error.details?.reason, 'SESSION_IDLE_EXPIRED');
  assert.equal(error.details?.idleExpiryMs, 1_500_000);
  assert.equal(error.details?.deviceKey, 'ios:sim-1');
  assert.equal(error.details?.session, 'cwd:abc:default');
  // The hint names the device the caller can now re-claim, and how to stop this happening again.
  assert.match(String(error.details?.hint), /ios:sim-1/);
  assert.match(String(error.details?.hint), new RegExp(SESSION_IDLE_EXPIRY_ENV));
});

test('an expiry marker without a device still explains itself without one', () => {
  const tombstone = buildIdleExpiryTombstone('default', {
    expiredAtMs: 1_000,
    idleExpiryMs: 5_000,
  });
  assert.equal('deviceKey' in tombstone, false);
  const error = sessionIdleExpiredError('default', tombstone, 6_000);
  assert.equal(error.details?.deviceKey, undefined);
  assert.match(String(error.details?.hint), new RegExp(SESSION_IDLE_EXPIRY_ENV));
});

/**
 * A capture handle and its envelope, built once for every capture kind this policy has to respect. The
 * idle-expiry policy asks only whether a capture is attached, so this handle never has to do anything
 * and the three handle shapes are cast rather than reproduced; the envelope is real because the
 * session field's type demands it.
 */
function makeTestCaptureResource<K extends string>(
  session: SessionState,
  resourceKind: K,
): { handle: never; envelope: DurableResourceEnvelope<K> } {
  const handle = {
    inspect: () => ({}),
    finish: async () => ({ status: 'completed' as const, result: {} }),
    forceCleanup: async () => ({ status: 'cleaned' as const }),
    setOutputPath: () => {},
    [Symbol.asyncDispose]: async () => {},
  };
  return {
    handle: handle as never,
    envelope: createDurableResourceEnvelope({
      resourceKind,
      sessionId: session.name,
      device: deviceIdentity(session.device),
      owner: localRuntimeOwner(session.device.platform),
      fence: { token: `test-${resourceKind}`, generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { fixture: true } },
    }),
  };
}

test('a session with any capture running is never idle-expired', () => {
  // Every one of these stamps the session once and then goes silent while the capture runs, so a
  // deadline measured from commands alone would call the session idle and destroy evidence its own
  // workflow is still collecting. Deleting any single guard below must fail this test.
  const running: Array<[string, (session: SessionState) => void]> = [
    ['screen recording', (s) => (s.screenRecording = makeTestScreenRecordingResource(s))],
    ['app logs', (s) => (s.appLog = makeTestCaptureResource(s, 'app-log'))],
    ['audio probe', (s) => (s.audioProbe = makeTestCaptureResource(s, 'audio-probe'))],
    ['performance capture', (s) => (s.perfCapture = makeTestCaptureResource(s, 'perf-capture'))],
    ['trace', (s) => (s.trace = { outPath: '/tmp/trace.trace', startedAt: 1 })],
  ];
  for (const [name, attach] of running) {
    const session = claimHoldingSession();
    attach(session);
    assert.equal(isIdleExpirableSession(session), false, `${name} must hold the session back`);
  }
  assert.equal(isIdleExpirableSession(claimHoldingSession()), true);
});
