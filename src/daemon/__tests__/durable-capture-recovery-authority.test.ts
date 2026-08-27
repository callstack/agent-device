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
    vi.useRealTimers();
  }
});

test.each(['active', 'missing'] as const)(
  'deadline disposes a late resolved %s authority after the race has timed out',
  async (lateStatus) => {
    vi.useFakeTimers();
    const combinedSignal = vi
      .spyOn(AbortSignal, 'any')
      .mockReturnValue(new AbortController().signal);
    try {
      let resolveReattach!: (
        outcome: { status: 'active'; handle: AppLogLiveHandle } | { status: 'missing' },
      ) => void;
      const disposalOrder: string[] = [];
      const forceCleanup = vi.fn(async () => {
        disposalOrder.push('handle');
        return { status: 'cleaned' } as const;
      });
      const disposeControl = vi.fn(async () => {
        disposalOrder.push('control');
      });
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
            await new Promise<
              { status: 'active'; handle: AppLogLiveHandle } | { status: 'missing' }
            >((resolve) => {
              resolveReattach = resolve;
            }),
          cleanup: async () => ({ status: 'already-missing' as const }),
          [Symbol.asyncDispose]: disposeControl,
        }),
        onLateCleanupFailure: () => {},
      });

      const timedOut = expect(acquisition).rejects.toBeInstanceOf(
        DurableCaptureRecoveryDeadlineError,
      );
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;

      resolveReattach(
        lateStatus === 'active'
          ? {
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
            }
          : { status: 'missing' },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(forceCleanup).toHaveBeenCalledTimes(lateStatus === 'active' ? 1 : 0);
      expect(disposeControl).toHaveBeenCalledOnce();
      expect(disposalOrder).toEqual(lateStatus === 'active' ? ['handle', 'control'] : ['control']);
    } finally {
      combinedSignal.mockRestore();
      vi.useRealTimers();
    }
  },
);

test('late handle cleanup failure does not skip control disposal when diagnostics throw', async () => {
  vi.useFakeTimers();
  const combinedSignal = vi.spyOn(AbortSignal, 'any').mockReturnValue(new AbortController().signal);
  try {
    const cleanupError = new Error('late handle cleanup failed');
    const reporterError = new Error('late cleanup diagnostic reporter failed');
    const cleanupFailures = vi.fn(() => {
      throw reporterError;
    });
    const disposeControl = vi.fn(async () => {});
    let resolveReattach!: (outcome: { status: 'active'; handle: AppLogLiveHandle }) => void;
    let signalReattachStarted!: () => void;
    const reattachStarted = new Promise<void>((resolve) => {
      signalReattachStarted = resolve;
    });
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
        reattach: async () => {
          signalReattachStarted();
          return await new Promise<{ status: 'active'; handle: AppLogLiveHandle }>((resolve) => {
            resolveReattach = resolve;
          });
        },
        cleanup: async () => ({ status: 'already-missing' as const }),
        [Symbol.asyncDispose]: disposeControl,
      }),
      onLateCleanupFailure: cleanupFailures,
    });
    const primaryErrorPromise = acquisition.catch((error: unknown) => error);
    await reattachStarted;
    await vi.advanceTimersByTimeAsync(25);
    const primaryError = await primaryErrorPromise;

    const forceCleanup = vi.fn(async () => {
      throw cleanupError;
    });
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

    expect(primaryError).toBeInstanceOf(DurableCaptureRecoveryDeadlineError);
    expect(forceCleanup).toHaveBeenCalledOnce();
    expect(cleanupFailures).toHaveBeenCalledWith(
      'late_handle_cleanup_failed',
      cleanupError,
      primaryError,
    );
    expect(disposeControl).toHaveBeenCalledOnce();
  } finally {
    combinedSignal.mockRestore();
    vi.useRealTimers();
  }
});

test('aborted recovery does not skip control disposal when late handle diagnostics throw', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const cancellation = new Error('request canceled');
    const cleanupError = new Error('late handle cleanup failed');
    const reporterError = new Error('late cleanup diagnostic reporter failed');
    const cleanupFailures = vi.fn(() => {
      throw reporterError;
    });
    const disposeControl = vi.fn(async () => {});
    let observedSignal: AbortSignal | undefined;
    let resolveReattach!: (outcome: { status: 'active'; handle: AppLogLiveHandle }) => void;
    let signalReattachStarted!: () => void;
    const reattachStarted = new Promise<void>((resolve) => {
      signalReattachStarted = resolve;
    });
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
        return {
          reattach: async () => {
            signalReattachStarted();
            return await new Promise<{ status: 'active'; handle: AppLogLiveHandle }>((resolve) => {
              resolveReattach = resolve;
            });
          },
          cleanup: async () => ({ status: 'already-missing' as const }),
          [Symbol.asyncDispose]: disposeControl,
        };
      },
      onLateCleanupFailure: cleanupFailures,
    });
    const primaryErrorPromise = acquisition.catch((error: unknown) => error);
    await reattachStarted;
    controller.abort(cancellation);
    const primaryError = await primaryErrorPromise;

    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(cancellation);
    resolveReattach({
      status: 'active',
      handle: createTestAppLogLiveHandle({
        inspect: () => ({ backend: 'android', state: 'active', startedAt: 1 }),
        finish: async () => ({
          status: 'completed',
          alreadyCompleted: true,
          result: { backend: 'android', outputPath: '/tmp/app.log', completedAt: 1 },
        }),
        forceCleanup: vi.fn(async () => {
          throw cleanupError;
        }),
      }),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(primaryError).toBe(cancellation);
    expect(cleanupFailures).toHaveBeenCalledWith(
      'late_handle_cleanup_failed',
      cleanupError,
      cancellation,
    );
    expect(disposeControl).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test.each(['deadline', 'cancellation'] as const)(
  'late control cleanup failure remains secondary to the %s error',
  async (winner) => {
    vi.useFakeTimers();
    const combinedSignal = vi
      .spyOn(AbortSignal, 'any')
      .mockReturnValue(new AbortController().signal);
    try {
      const controller = new AbortController();
      const cancellation = new Error('request canceled');
      const cleanupError = new Error('late cleanup failed');
      const cleanupFailures = vi.fn(() => {
        throw new Error('cleanup diagnostic reporter failed');
      });
      let resolveReattach!: (outcome: { status: 'missing' }) => void;
      const acquisition = acquireDurableCaptureRecoveryAuthorityBeforeDeadline({
        displayName: 'app-log',
        envelope,
        scope: {
          signal: controller.signal,
          diagnostics: { emit: () => {} },
          progress: { report: () => {} },
        },
        deadlineMs: 25,
        acquireControl: async () => ({
          reattach: async () =>
            await new Promise<{ status: 'missing' }>((resolve) => {
              resolveReattach = resolve;
            }),
          cleanup: async () => ({ status: 'already-missing' as const }),
          [Symbol.asyncDispose]: async () => {
            throw cleanupError;
          },
        }),
        onLateCleanupFailure: cleanupFailures,
      });
      const primaryErrorPromise = acquisition.catch((error: unknown) => error);
      await Promise.resolve();

      if (winner === 'deadline') {
        await vi.advanceTimersByTimeAsync(25);
      } else {
        controller.abort(cancellation);
      }
      const primaryError = await primaryErrorPromise;

      resolveReattach({ status: 'missing' });
      await vi.advanceTimersByTimeAsync(0);

      if (winner === 'deadline') {
        expect(primaryError).toBeInstanceOf(DurableCaptureRecoveryDeadlineError);
      } else {
        expect(primaryError).toBe(cancellation);
      }
      expect(cleanupFailures).toHaveBeenCalledWith(
        'late_control_cleanup_failed',
        cleanupError,
        primaryError,
      );
    } finally {
      combinedSignal.mockRestore();
      vi.useRealTimers();
    }
  },
);

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
