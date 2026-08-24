import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

import { runReplayTestAttempt } from '../session-test-runtime.ts';

import type { ReplayTestAttemptOutcome } from '../session-test-types.ts';

// What the scheduler owes its host around cancellation (#1478 P3b): cancel exactly once when
// an attempt times out, and always release when it settles. How the daemon then maps that onto
// its request registry is the adapter's contract, pinned in
// `src/daemon/handlers/__tests__/session-replay-cancellation.test.ts`.
const cancellations: Array<{ attemptId: string; canceled: number; released: number }> = [];

function trackCancellation() {
  cancellations.length = 0;
  return {
    emitDiagnostic: () => {},
    bindAttemptCancellation: ({ attemptId }: { attemptId: string }) => {
      const record = { attemptId, canceled: 0, released: 0 };
      cancellations.push(record);
      return {
        cancel: () => {
          record.canceled += 1;
        },
        release: () => {
          record.released += 1;
        },
      };
    },
  };
}

const PASSED: ReplayTestAttemptOutcome = {
  status: 'passed',
  replayed: 1,
  healed: 0,
  warnings: [],
  artifactPaths: [],
};

afterEach(() => {
  vi.useRealTimers();
});

function makeArtifactsDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-device-test-runtime-${label}-`));
}

function readTimingEventTypes(artifactsDir: string): string[] {
  const trace = fs.readFileSync(path.join(artifactsDir, 'replay-timing.ndjson'), 'utf8');
  return trace
    .split('\n')
    .filter(Boolean)
    .map((line) => String((JSON.parse(line) as { type: unknown }).type));
}

test('runReplayTestAttempt keeps cancellation active until a timed-out replay settles', async () => {
  vi.useFakeTimers();

  let resolveReplay: ((outcome: ReplayTestAttemptOutcome) => void) | undefined;
  const replayPromise = new Promise<ReplayTestAttemptOutcome>((resolve) => {
    resolveReplay = resolve;
  });
  const replaySettled = replayPromise.then(() => undefined);
  const lifecycleEvents: string[] = [];
  const cleanupSession = vi.fn(async () => {
    lifecycleEvents.push('cleanup');
    // The deferred late cleanup is best-effort: its failure is diagnosed, never surfaced.
    if (cleanupSession.mock.calls.length > 1) throw new Error('late cleanup failed');
  });
  const finalizeAttempt = vi.fn(async () => {
    lifecycleEvents.push('finalize');
    return undefined;
  });

  const attemptPromise = runReplayTestAttempt({
    filePath: '01-timeout.ad',
    sessionName: 'default:test:timeout',
    requestId: 'req-timeout-open',
    timeoutMs: 10,
    runReplay: async () => await replayPromise,
    finalizeAttempt,
    cleanupSession,
    ...trackCancellation(),
  });

  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersByTimeAsync(2_000);

  const result = await attemptPromise;
  expect(result.status).toBe('failed');
  if (result.status === 'failed') {
    expect(result.error.message).toContain('TIMEOUT after 10ms');
    expect(result.error.details?.reason).toBe('timeout_cleanup_pending');
    expect(result.error.details?.timeoutCleanupPending).toBe(true);
    // The abandoned replay still owns the device, so the outcome is tagged infrastructure and
    // the scheduler stops the suite instead of retrying into a contended session.
    expect(result.infrastructure).toBe(true);
  }
  expect(cleanupSession).toHaveBeenCalledWith('default:test:timeout');
  expect(finalizeAttempt).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionName: 'default:test:timeout',
      artifactPaths: expect.any(Set),
    }),
  );
  expect(lifecycleEvents).toEqual(['finalize', 'cleanup']);
  expect(cancellations[0]?.canceled).toBe(1);
  // #1478 P3: the second cleanup is strictly deferred until the abandoned replay settles, so
  // the attempt returns having cleaned up exactly once. P3 keeps this orchestration inside
  // replay-test while the cleanup effect itself stays in the daemon adapter.
  expect(cleanupSession).toHaveBeenCalledTimes(1);

  resolveReplay?.({
    status: 'failed',
    error: { code: 'COMMAND_FAILED', message: 'request canceled' },
    artifactPaths: [],
    infrastructure: false,
  });
  await replaySettled;
  await vi.waitFor(() => {
    expect(cancellations[0]?.released).toBe(1);
  });
  await vi.waitFor(() => {
    expect(cleanupSession).toHaveBeenCalledTimes(2);
  });
  expect(lifecycleEvents).toEqual(['finalize', 'cleanup', 'cleanup']);
  await expect(attemptPromise).resolves.toBe(result);
});

test('runReplayTestAttempt keeps a passing replay passed when finalization fails', async () => {
  const cleanupSession = vi.fn(async () => {});

  const result = await runReplayTestAttempt({
    filePath: '01-pass.ad',
    sessionName: 'default:test:pass',
    requestId: 'req-pass',
    runReplay: async () => PASSED,
    finalizeAttempt: async () => ({
      status: 'failed',
      error: { code: 'COMMAND_FAILED', message: 'failed to stop recording' },
      artifactPaths: [],
      infrastructure: false,
    }),
    cleanupSession,
    ...trackCancellation(),
  });

  expect(result.status).toBe('passed');
  if (result.status !== 'passed') throw new Error(result.error.message);
  expect(result.warnings).toEqual(['Replay test finalization failed: failed to stop recording']);
  expect(cleanupSession).toHaveBeenCalledWith('default:test:pass');
});

test('runReplayTestAttempt marks a failed cleanup as infrastructure so the scheduler cannot retry into its session', async () => {
  const cleanupSession = vi.fn(async () => {
    throw new Error('macOS session still owns host-macos-local');
  });

  const result = await runReplayTestAttempt({
    filePath: '01-cleanup-failure.ad',
    sessionName: 'default:test:cleanup-failure',
    requestId: 'req-cleanup-failure',
    runReplay: async () => ({
      status: 'failed',
      error: { code: 'COMMAND_FAILED', message: 'open "System Settings" failed' },
      artifactPaths: [],
      infrastructure: false,
    }),
    cleanupSession,
    ...trackCancellation(),
  });

  expect(result.status).toBe('failed');
  if (result.status === 'failed') {
    expect(result.error.message).toBe('open "System Settings" failed');
    expect(result.infrastructure).toBe(true);
  }
  expect(cleanupSession).toHaveBeenCalledWith('default:test:cleanup-failure');
});

// #1478 P3 characterization: attempt finalization happens before cleanup, always, and the
// timing trace is the durable evidence of that order. P3 moves this `finally` orchestration
// into replay-test, so the order and the recorded event names are pinned here as shipped.
test('runReplayTestAttempt finalizes before cleanup and records that order in the timing trace', async () => {
  const artifactsDir = makeArtifactsDir('order');
  const lifecycleEvents: string[] = [];

  const result = await runReplayTestAttempt({
    filePath: '01-order.ad',
    sessionName: 'default:test:order',
    requestId: 'req-order',
    artifactsDir,
    runReplay: async () => {
      lifecycleEvents.push('replay');
      return PASSED;
    },
    finalizeAttempt: async () => {
      lifecycleEvents.push('finalize');
      return undefined;
    },
    cleanupSession: async () => {
      lifecycleEvents.push('cleanup');
    },
    ...trackCancellation(),
  });

  expect(result.status).toBe('passed');
  expect(lifecycleEvents).toEqual(['replay', 'finalize', 'cleanup']);
  expect(readTimingEventTypes(artifactsDir)).toEqual([
    'replay_test_attempt_start',
    'replay_test_attempt_stop',
    'replay_test_finalize_start',
    'replay_test_finalize_stop',
    'replay_test_cleanup_start',
    'replay_test_cleanup_stop',
  ]);
});

test('runReplayTestAttempt cleans up once when a timed-out replay settles inside the grace window', async () => {
  vi.useFakeTimers();
  const artifactsDir = makeArtifactsDir('grace');

  let resolveReplay: ((outcome: ReplayTestAttemptOutcome) => void) | undefined;
  const replayPromise = new Promise<ReplayTestAttemptOutcome>((resolve) => {
    resolveReplay = resolve;
  });
  const lifecycleEvents: string[] = [];
  const cleanupSession = vi.fn(async () => {
    lifecycleEvents.push('cleanup');
  });

  const attemptPromise = runReplayTestAttempt({
    filePath: '01-late.ad',
    sessionName: 'default:test:late',
    requestId: 'req-timeout-grace',
    timeoutMs: 10,
    artifactsDir,
    runReplay: async () => await replayPromise,
    finalizeAttempt: async () => {
      lifecycleEvents.push('finalize');
      return undefined;
    },
    cleanupSession,
    ...trackCancellation(),
  });

  await vi.advanceTimersByTimeAsync(10);
  // The replay comes back inside the 2s grace window, so no cleanup race is declared.
  resolveReplay?.(PASSED);

  const result = await attemptPromise;
  // The raced timeout outcome still wins: a late success does not un-fail the attempt.
  expect(result.status).toBe('failed');
  if (result.status === 'failed') {
    expect(result.error.message).toBe('TIMEOUT after 10ms');
    expect(result.error.details?.reason).toBe('timeout');
    expect(result.error.details?.timeoutCleanupPending).toBe(undefined);
    expect(result.error.details?.timeoutMode).toBe('cooperative');
    expect(result.infrastructure).toBe(false);
  }
  expect(lifecycleEvents).toEqual(['finalize', 'cleanup']);
  expect(cleanupSession).toHaveBeenCalledTimes(1);
  expect(readTimingEventTypes(artifactsDir)).toEqual([
    'replay_test_attempt_start',
    'replay_test_attempt_stop',
    'replay_test_finalize_start',
    'replay_test_finalize_stop',
    'replay_test_cleanup_start',
    'replay_test_cleanup_stop',
  ]);
});

test('runReplayTestAttempt cleans up without a finalizer and adds no finalization warning', async () => {
  const cleanupSession = vi.fn(async () => {});

  const result = await runReplayTestAttempt({
    filePath: '01-no-finalizer.ad',
    sessionName: 'default:test:no-finalizer',
    requestId: 'req-no-finalizer',
    runReplay: async () => PASSED,
    cleanupSession,
    ...trackCancellation(),
  });

  expect(result.status).toBe('passed');
  if (result.status !== 'passed') throw new Error(result.error.message);
  expect(result.warnings).toEqual([]);
  expect(cleanupSession).toHaveBeenCalledWith('default:test:no-finalizer');
});
