import { expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import type { AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createTestAppLogLiveHandle } from '../../__tests__/test-utils/app-log-live-handle.ts';
import {
  acquireDurableCaptureRecoveryAuthorityBeforeDeadline,
  DurableCaptureRecoveryDeadlineError,
} from '../durable-capture-recovery-authority.ts';

const envelope = createDurableResourceEnvelope({
  resourceKind: 'app-log',
  sessionId: 'session',
  device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
  owner: localRuntimeOwner('android'),
  fence: { token: 'fence', generation: 1 },
  lifecycle: 'open',
  descriptor: { version: 1, body: {} },
});

test('acquisition winner leaves authority disposal to the caller', async () => {
  const disposeControl = vi.fn(async () => {});
  const authority = await acquireDurableCaptureRecoveryAuthorityBeforeDeadline({
    displayName: 'app-log',
    envelope,
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    deadlineMs: 10_000,
    acquireControl: async () => ({
      reattach: async () => ({ status: 'missing' as const }),
      cleanup: async () => ({ status: 'already-missing' as const }),
      [Symbol.asyncDispose]: disposeControl,
    }),
    onLateCleanupFailure: () => {},
  });

  expect(authority.reattached).toEqual({ status: 'missing' });
  expect(disposeControl).not.toHaveBeenCalled();
  await authority.control[Symbol.asyncDispose]();
  expect(disposeControl).toHaveBeenCalledOnce();
});

test('deadline abort disposes authority that becomes active after the caller has timed out', async () => {
  vi.useFakeTimers();
  const combinedSignal = vi.spyOn(AbortSignal, 'any').mockReturnValue(new AbortController().signal);
  try {
    let resolveReattach!: (outcome: { status: 'active'; handle: AppLogLiveHandle }) => void;
    const forceCleanup = vi.fn(async () => ({ status: 'cleaned' }) as const);
    const disposeControl = vi.fn(async () => {});
    const cleanupFailures = vi.fn();
    const acquisition = acquireDurableCaptureRecoveryAuthorityBeforeDeadline({
      displayName: 'app-log',
      envelope,
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
      deadlineMs: 25,
      acquireControl: async () => ({
        reattach: async () =>
          await new Promise<{ status: 'active'; handle: AppLogLiveHandle }>((resolve) => {
            resolveReattach = resolve;
          }),
        cleanup: async () => ({ status: 'already-missing' }),
        [Symbol.asyncDispose]: disposeControl,
      }),
      onLateCleanupFailure: cleanupFailures,
    });

    const timedOut = expect(acquisition).rejects.toBeInstanceOf(
      DurableCaptureRecoveryDeadlineError,
    );
    await vi.advanceTimersByTimeAsync(25);
    await timedOut;

    resolveReattach({
      status: 'active',
      handle: createTestAppLogLiveHandle({
        inspect: () => ({ backend: 'android', state: 'active', startedAt: 1 }),
        finish: async () => ({
          status: 'completed',
          alreadyCompleted: true,
          result: { backend: 'android', outputPath: '/tmp/app.log', completedAt: 1 },
        }),
        forceCleanup,
      }),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(forceCleanup).toHaveBeenCalledOnce();
    expect(disposeControl).toHaveBeenCalledOnce();
    expect(cleanupFailures).not.toHaveBeenCalled();
  } finally {
    combinedSignal.mockRestore();
    vi.useRealTimers();
  }
});

test('deadline abort disposes control when late reattach reports a non-active outcome', async () => {
  vi.useFakeTimers();
  const combinedSignal = vi.spyOn(AbortSignal, 'any').mockReturnValue(new AbortController().signal);
  try {
    let resolveReattach!: (outcome: { status: 'missing' }) => void;
    const disposeControl = vi.fn(async () => {});
    const acquisition = acquireDurableCaptureRecoveryAuthorityBeforeDeadline({
      displayName: 'app-log',
      envelope,
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
      deadlineMs: 25,
      acquireControl: async () => ({
        reattach: async () =>
          await new Promise<{ status: 'missing' }>((resolve) => {
            resolveReattach = resolve;
          }),
        cleanup: async () => ({ status: 'already-missing' }),
        [Symbol.asyncDispose]: disposeControl,
      }),
      onLateCleanupFailure: () => {},
    });

    const timedOut = expect(acquisition).rejects.toBeInstanceOf(
      DurableCaptureRecoveryDeadlineError,
    );
    await vi.advanceTimersByTimeAsync(25);
    await timedOut;

    resolveReattach({ status: 'missing' });
    await vi.advanceTimersByTimeAsync(0);

    expect(disposeControl).toHaveBeenCalledOnce();
  } finally {
    combinedSignal.mockRestore();
    vi.useRealTimers();
  }
});

test('cancellation keeps its primary error when late control cleanup fails', async () => {
  const controller = new AbortController();
  const cancellation = new Error('request canceled');
  const cleanupError = new Error('late cleanup failed');
  const combinedSignal = vi.spyOn(AbortSignal, 'any').mockReturnValue(new AbortController().signal);
  let publishControl!: (control: {
    reattach: () => Promise<{ status: 'missing' }>;
    cleanup: () => Promise<{ status: 'already-missing' }>;
    [Symbol.asyncDispose]: () => Promise<void>;
  }) => void;
  const cleanupFailures = vi.fn();
  try {
    const acquisition = acquireDurableCaptureRecoveryAuthorityBeforeDeadline({
      displayName: 'app-log',
      envelope,
      scope: {
        signal: controller.signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
      deadlineMs: 10_000,
      acquireControl: async () =>
        await new Promise((resolve) => {
          publishControl = resolve;
        }),
      onLateCleanupFailure: cleanupFailures,
    });

    controller.abort(cancellation);
    await expect(acquisition).rejects.toBe(cancellation);

    publishControl({
      reattach: async () => ({ status: 'missing' }),
      cleanup: async () => ({ status: 'already-missing' }),
      [Symbol.asyncDispose]: async () => {
        throw cleanupError;
      },
    });

    await vi.waitFor(() =>
      expect(cleanupFailures).toHaveBeenCalledWith(
        'late_control_cleanup_failed',
        cleanupError,
        cancellation,
      ),
    );
  } finally {
    combinedSignal.mockRestore();
  }
});

test('request cancellation wins before the deadline and disposes late exact-owner control', async () => {
  const controller = new AbortController();
  const cancellation = new Error('request canceled');
  const disposeControl = vi.fn(async () => {});
  let publishControl!: (control: {
    reattach: () => Promise<{ status: 'missing' }>;
    cleanup: () => Promise<{ status: 'already-missing' }>;
    [Symbol.asyncDispose]: () => Promise<void>;
  }) => void;
  let observedSignal: AbortSignal | undefined;
  let rejection: unknown;
  const acquisition = acquireDurableCaptureRecoveryAuthorityBeforeDeadline({
    displayName: 'app-log',
    envelope,
    scope: {
      signal: controller.signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    deadlineMs: 10_000,
    acquireControl: async (_candidate, scope) => {
      observedSignal = scope.signal;
      return await new Promise((resolve) => {
        publishControl = resolve;
      });
    },
    onLateCleanupFailure: () => {},
  });
  void acquisition.catch((error: unknown) => {
    rejection = error;
  });
  await Promise.resolve();
  controller.abort(cancellation);
  await Promise.resolve();

  expect(observedSignal?.aborted).toBe(true);
  expect(observedSignal?.reason).toBe(cancellation);
  await vi.waitFor(() => expect(rejection).toBe(cancellation));

  publishControl({
    reattach: async () => ({ status: 'missing' }),
    cleanup: async () => ({ status: 'already-missing' }),
    [Symbol.asyncDispose]: disposeControl,
  });
  await expect(acquisition).rejects.toBe(cancellation);
  expect(disposeControl).toHaveBeenCalledOnce();
});

test('already-canceled recovery acquires no exact-owner authority', async () => {
  const controller = new AbortController();
  const cancellation = new Error('request already canceled');
  controller.abort(cancellation);
  const acquireControl = vi.fn(async () => {
    throw new Error('must not acquire');
  });

  await expect(
    acquireDurableCaptureRecoveryAuthorityBeforeDeadline({
      displayName: 'app-log',
      envelope,
      scope: {
        signal: controller.signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
      deadlineMs: 10_000,
      acquireControl,
      onLateCleanupFailure: () => {},
    }),
  ).rejects.toBe(cancellation);
  expect(acquireControl).not.toHaveBeenCalled();
});
