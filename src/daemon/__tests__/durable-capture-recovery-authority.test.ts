import { expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { localRuntimeOwner, type AppLogLiveHandle } from '@agent-device/contracts/platform';
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
