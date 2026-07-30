import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { DaemonResponse } from '../../types.ts';
import { isRequestCanceled } from '../../../request/cancel.ts';
import { runReplayTestAttempt } from '../session-test-runtime.ts';

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

  let resolveReplay: ((response: DaemonResponse) => void) | undefined;
  const replayPromise = new Promise<DaemonResponse>((resolve) => {
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
  });

  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersByTimeAsync(2_000);

  const result = await attemptPromise;
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.message).toContain('TIMEOUT after 10ms');
    expect(result.error.details?.reason).toBe('timeout_cleanup_pending');
    expect(result.error.details?.timeoutCleanupPending).toBe(true);
  }
  expect(cleanupSession).toHaveBeenCalledWith('default:test:timeout');
  expect(finalizeAttempt).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionName: 'default:test:timeout',
      artifactPaths: expect.any(Set),
    }),
  );
  expect(lifecycleEvents).toEqual(['finalize', 'cleanup']);
  expect(isRequestCanceled('req-timeout-open')).toBe(true);
  // #1478 P3: the second cleanup is strictly deferred until the abandoned replay settles, so
  // the attempt returns having cleaned up exactly once. P3 keeps this orchestration inside
  // replay-test while the cleanup effect itself stays in the daemon adapter.
  expect(cleanupSession).toHaveBeenCalledTimes(1);

  resolveReplay?.({
    ok: false,
    error: { code: 'COMMAND_FAILED', message: 'request canceled' },
  });
  await replaySettled;
  await vi.waitFor(() => {
    expect(isRequestCanceled('req-timeout-open')).toBe(false);
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
    runReplay: async () => ({ ok: true, data: { replayed: 1, healed: 0 } }),
    finalizeAttempt: async () => ({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'failed to stop recording' },
    }),
    cleanupSession,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data?.warnings).toEqual([
    'Replay test finalization failed: failed to stop recording',
  ]);
  expect(cleanupSession).toHaveBeenCalledWith('default:test:pass');
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
      return { ok: true, data: { replayed: 1, healed: 0 } };
    },
    finalizeAttempt: async () => {
      lifecycleEvents.push('finalize');
      return undefined;
    },
    cleanupSession: async () => {
      lifecycleEvents.push('cleanup');
    },
  });

  expect(result.ok).toBe(true);
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

  let resolveReplay: ((response: DaemonResponse) => void) | undefined;
  const replayPromise = new Promise<DaemonResponse>((resolve) => {
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
  });

  await vi.advanceTimersByTimeAsync(10);
  // The replay comes back inside the 2s grace window, so no cleanup race is declared.
  resolveReplay?.({ ok: true, data: { replayed: 1, healed: 0 } });

  const result = await attemptPromise;
  // The raced timeout response still wins: a late success does not un-fail the attempt.
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.message).toBe('TIMEOUT after 10ms');
    expect(result.error.details?.reason).toBe('timeout');
    expect(result.error.details?.timeoutCleanupPending).toBe(undefined);
    expect(result.error.details?.timeoutMode).toBe('cooperative');
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
    runReplay: async () => ({ ok: true, data: { replayed: 1, healed: 0 } }),
    cleanupSession,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data?.warnings).toBe(undefined);
  expect(cleanupSession).toHaveBeenCalledWith('default:test:no-finalizer');
});
