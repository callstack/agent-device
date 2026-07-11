import { afterEach, expect, test, vi } from 'vitest';
import type { DaemonResponse } from '../../types.ts';
import { isRequestCanceled } from '../../../request/cancel.ts';
import { runReplayTestAttempt } from '../session-test-runtime.ts';

afterEach(() => {
  vi.useRealTimers();
});

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
