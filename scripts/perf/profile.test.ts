import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  aggregateProfiles,
  profileRequestLog,
  readClientDiagnostics,
  readSettleFacts,
} from './profile.ts';
import type { Sample } from './types.ts';

const line = (event: Record<string, unknown>) => JSON.stringify({ level: 'info', ...event });

// Trimmed from a heavy-feed `press` request log.
const PRESS_LOG = [
  line({ ts: '2026-10-21T19:00:00.000Z', phase: 'request_start', data: { command: 'press' } }),
  line({
    phase: 'exec_command',
    durationMs: 0.02,
    data: { command: 'xcrun', event: 'spawn_start' },
  }),
  line({ phase: 'exec_command', durationMs: 9, data: { command: 'xcrun', event: 'spawn' } }),
  line({ phase: 'exec_command', durationMs: 120, data: { command: 'xcrun', event: 'exit' } }),
  line({ phase: 'exec_command', durationMs: 121, data: { command: 'xcrun', event: 'settled' } }),
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
  line({ phase: 'retry', data: { event: 'attempt_failed', attempt: 1 } }),
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
    '[agent-device][diag] {"phase":"daemon_startup","durationMs":30,"requestId":"r1"}',
    'noise',
    '[agent-device][diag] {"phase":"daemon_request","durationMs":812,"requestId":"r1"}',
  ].join('\n');
  assert.deepEqual(readClientDiagnostics(stderr), { daemonMs: 812, requestId: 'r1' });
  assert.deepEqual(readClientDiagnostics('[agent-device][diag] {"phase":"daemon_req'), {});
});

test('reads the settle wait of a --settle response and nothing from other responses', () => {
  assert.deepEqual(
    readSettleFacts({ data: { settle: { settled: true, waitedMs: 1665, captures: 2 } } }),
    { waitedMs: 1665, captures: 2, settled: true },
  );
  assert.equal(readSettleFacts({ data: { message: 'Tapped' } }), undefined);
});
