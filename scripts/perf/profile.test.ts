import assert from 'node:assert/strict';
import { EXEC_COMMAND_PHASE } from '@agent-device/host-kit/command';
import { DIAGNOSTIC_STDERR_PREFIX } from '@agent-device/host-kit/diagnostics';
import { RETRY_PHASE } from '@agent-device/host-kit/retry';
import {
  ANDROID_SNAPSHOT_HELPER_CAPTURE_PHASE,
  ANDROID_SNAPSHOT_HELPER_SESSION_CAPTURE_PHASE,
  ANDROID_TOUCH_HELPER_GESTURE_PHASE,
} from '@agent-device/platform-android/mechanics';
import { test } from 'vitest';
import { DAEMON_REQUEST_PHASE } from '../../src/daemon-client/daemon-client.ts';
import {
  aggregateProfiles,
  profileRequestLog,
  readClientDiagnostics,
  readSettleFacts,
  readSnapshotFacts,
} from './profile.ts';
import type { Sample } from './types.ts';

const line = (event: Record<string, unknown>) => JSON.stringify({ level: 'info', ...event });

// Trimmed from a heavy-feed `press` request log.
const PRESS_LOG = [
  line({ ts: '2026-10-21T19:00:00.000Z', phase: 'request_start', data: { command: 'press' } }),
  line({
    phase: EXEC_COMMAND_PHASE,
    durationMs: 0.02,
    data: { command: 'xcrun', event: 'spawn_start' },
  }),
  line({ phase: EXEC_COMMAND_PHASE, durationMs: 9, data: { command: 'xcrun', event: 'spawn' } }),
  line({ phase: EXEC_COMMAND_PHASE, durationMs: 120, data: { command: 'xcrun', event: 'exit' } }),
  line({
    phase: EXEC_COMMAND_PHASE,
    durationMs: 121,
    data: { command: 'xcrun', event: 'settled' },
  }),
  line({
    level: 'error',
    phase: 'ios.snapshot-source.acquire',
    durationMs: 80,
    data: { producer: 'simulator-ax-bridge', error: 'unsupported: foreground-owner-unverified' },
  }),
  line({
    phase: 'ios.snapshot-source.acquire',
    durationMs: 160,
    data: { producer: 'simulator-ax-bridge' },
  }),
  line({
    phase: 'ios_snapshot_source_recovery',
    data: { producer: 'simulator-ax-bridge', truncated: true, acceptedLevels: 32 },
  }),
  line({ phase: RETRY_PHASE, data: { event: 'attempt_failed', attempt: 1 } }),
  line({ phase: 'ios_runner_command_send', durationMs: 900, data: { command: 'tap' } }),
  line({ phase: 'post_gesture_snapshot_stabilized', data: { attempts: 2, durationMs: 300 } }),
  line({
    ts: '2026-10-21T19:00:01.250Z',
    level: 'warn',
    phase: 'ios_runner_session_invalidated',
    data: { reason: 'stale' },
  }),
  'not json',
].join('\n');

test('profiles runner, spawn, snapshot-source, retry, and settle phases of one request', () => {
  const profile = profileRequestLog(PRESS_LOG);
  assert.deepEqual(profile.spawns, { xcrun: { count: 1, totalMs: 121 } });
  assert.deepEqual(profile.runnerCommands, { tap: { count: 1, totalMs: 900 } });
  assert.deepEqual(profile.snapshotSources, {
    'simulator-ax-bridge': { count: 2, totalMs: 240, failures: 1 },
  });
  assert.equal(profile.retries, 1);
  assert.equal(profile.requestSpanMs, 1250);
  assert.deepEqual(profile.stabilization, { count: 1, totalMs: 300 });
  assert.deepEqual(profile.fallbacks, [
    'ios_runner_session_invalidated: stale',
    'simulator-ax-bridge: truncated at 32 levels',
    'simulator-ax-bridge: unsupported: foreground-owner-unverified',
  ]);
});

test('counts a producer only for samples where it answered', () => {
  const failedOnly = profileRequestLog(
    line({
      level: 'error',
      phase: 'ios.snapshot-source.acquire',
      durationMs: 5,
      data: { producer: 'simulator-ax-bridge', error: 'cancelled' },
    }),
  );
  const runnerSnapshot = profileRequestLog(
    line({ phase: 'ios_runner_command_send', durationMs: 4000, data: { command: 'snapshot' } }),
  );
  const samples: Sample[] = [
    { round: 0, ok: true, wallClockMs: 1, profile: failedOnly },
    {
      round: 1,
      ok: true,
      wallClockMs: 1,
      profile: runnerSnapshot,
      snapshot: { backend: 'private-ax', state: 'recovered', reasonCode: 'ax-rejected' },
    },
    { round: 2, ok: false, wallClockMs: 1, profile: profileRequestLog(PRESS_LOG) },
  ];
  const aggregate = aggregateProfiles(samples)!;
  assert.deepEqual(aggregate.producers, { 'apple-runner': 1 });
  assert.deepEqual(aggregate.backends, { 'private-ax/recovered/ax-rejected': 1 });
});

test('reads the client daemon timer from --debug stderr', () => {
  const stderr = [
    `${DIAGNOSTIC_STDERR_PREFIX}{"phase":"daemon_startup","durationMs":30,"requestId":"r1"}`,
    'noise',
    `${DIAGNOSTIC_STDERR_PREFIX}{"phase":"${DAEMON_REQUEST_PHASE}","durationMs":812,"requestId":"r1"}`,
  ].join('\n');
  assert.deepEqual(readClientDiagnostics(stderr), { daemonMs: 812, requestId: 'r1' });
  assert.deepEqual(readClientDiagnostics(`${DIAGNOSTIC_STDERR_PREFIX}{"phase":"daemon_req`), {});
});

test('reads the settle wait of a --settle response and nothing from other responses', () => {
  assert.deepEqual(
    readSettleFacts({ data: { settle: { settled: true, waitedMs: 1665, captures: 2 } } }),
    { waitedMs: 1665, captures: 2, settled: true },
  );
  assert.equal(readSettleFacts({ data: { message: 'Tapped' } }), undefined);
});

// Trimmed from Android heavy-feed request logs.
const androidCapture = (session: Record<string, unknown>, oneShot = false) =>
  [
    line({ phase: ANDROID_SNAPSHOT_HELPER_SESSION_CAPTURE_PHASE, ...session }),
    ...(oneShot
      ? [
          line({
            level: 'debug',
            phase: 'exec_command',
            durationMs: 373,
            data: { command: 'adb', event: 'settled' },
          }),
          line({ phase: ANDROID_SNAPSHOT_HELPER_CAPTURE_PHASE, durationMs: 373 }),
        ]
      : []),
    line({ phase: 'snapshot_capture', durationMs: 380, data: { backend: 'android' } }),
  ].join('\n');

test('names the Android helper transport that answered each capture', () => {
  const session = profileRequestLog(androidCapture({ durationMs: 40 }));
  assert.deepEqual(session.snapshotSources, {
    'android-helper/persistent-session': { count: 1, totalMs: 40, failures: 0 },
  });
  assert.deepEqual(session.fallbacks, []);

  // With the session off, the session timer settles cleanly and a one-shot capture answers.
  const sessionOff = profileRequestLog(androidCapture({ durationMs: 0 }, true));
  assert.deepEqual(sessionOff.snapshotSources, {
    'android-helper/persistent-session': { count: 1, totalMs: 0, failures: 1 },
    'android-helper/instrumentation': { count: 1, totalMs: 373, failures: 0 },
  });
  assert.deepEqual(sessionOff.spawns, { adb: { count: 1, totalMs: 373 } });
  assert.deepEqual(
    aggregateProfiles([{ round: 0, ok: true, wallClockMs: 1, profile: sessionOff }])!.producers,
    {
      'android-helper/instrumentation': 1,
    },
  );

  const sessionFailed = profileRequestLog(
    [
      androidCapture({ level: 'error', durationMs: 5000, data: { error: 'socket closed' } }, true),
      line({
        level: 'warn',
        phase: 'android_snapshot_helper_session_fallback',
        data: { reason: 'socket closed' },
      }),
    ].join('\n'),
  );
  assert.deepEqual(sessionFailed.snapshotSources['android-helper/persistent-session'], {
    count: 1,
    totalMs: 5000,
    failures: 1,
  });
  assert.deepEqual(sessionFailed.fallbacks, [
    'android-helper/persistent-session: socket closed',
    'android_snapshot_helper_session_fallback: socket closed',
  ]);
});

test('counts Android helper gestures as runner commands', () => {
  const profile = profileRequestLog(
    [
      line({ phase: ANDROID_TOUCH_HELPER_GESTURE_PHASE, durationMs: 210 }),
      line({
        level: 'error',
        phase: ANDROID_TOUCH_HELPER_GESTURE_PHASE,
        durationMs: 30,
        data: { error: 'busy' },
      }),
    ].join('\n'),
  );
  assert.deepEqual(profile.runnerCommands, { gesture: { count: 2, totalMs: 240 } });
  assert.deepEqual(profile.fallbacks, [`${ANDROID_TOUCH_HELPER_GESTURE_PHASE}: busy`]);
});

test('reads the Android helper transport from a snapshot response', () => {
  const facts = readSnapshotFacts({
    data: {
      nodes: [{ depth: 0 }, { depth: 60 }],
      snapshotQuality: { state: 'healthy', backend: 'android-helper' },
      androidSnapshot: { backend: 'android-helper', helperTransport: 'instrumentation' },
    },
  });
  assert.deepEqual(facts, {
    backend: 'android-helper',
    transport: 'instrumentation',
    state: 'healthy',
    reasonCode: undefined,
    nodeCount: 2,
    maxDepth: 60,
    truncated: undefined,
  });
});
