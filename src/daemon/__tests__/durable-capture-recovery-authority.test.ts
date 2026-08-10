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
