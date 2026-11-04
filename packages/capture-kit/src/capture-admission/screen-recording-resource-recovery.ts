import path from 'node:path';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import { sameDeviceIdentity, type DeviceIdentity } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { withDurableCaptureResourceFence } from '../durable-capture/fence.ts';
import { createStopProgress } from '../durable-capture/transitions.ts';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import {
  type BoundDeviceRuntime,
  type DeviceRuntimeGateway,
  narrowDeviceBinding,
  sameRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingLiveHandle,
} from '@agent-device/contracts/screen-recording-runtime';
import { screenRecordingRecoveryUse } from '@agent-device/contracts/screen-recording-runtime-plan';
import type { DurableCaptureRecoveryControl } from '../durable-capture/index.ts';
import { acquireExactDurableCaptureRecoveryControl } from './durable-capture-runtime-recovery.ts';
import { screenRecordingDurableResource } from './screen-recording-session-resource.ts';

type ScreenRecordingRecoveryRuntime = BoundDeviceRuntime<typeof screenRecordingRecoveryUse>;

export async function recoverScreenRecordingResourceAfterDaemonLock(params: {
  sessionsDir: string;
  resourcePath: string;
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  claim: Readonly<{ sessionId: string; device: DeviceIdentity }>;
  perRecordDeadlineMs?: number;
}): Promise<'ignored' | { status: 'retained'; reason: string }> {
  const store = screenRecordingDurableResource.store;
  const record = store.read(params.resourcePath);
  if (record.status === 'missing') return { status: 'retained', reason: 'resource-missing' };
  if (record.status !== 'decoded') return { status: 'retained', reason: record.reason };
  const expected = record.envelope;
  if (
    expected.sessionId !== params.claim.sessionId ||
    !sameDeviceIdentity(expected.device, params.claim.device)
  )
    return { status: 'retained', reason: 'owner-mismatch' };
  if (expected.lifecycle === 'completed') return 'ignored';
  if (
    path.resolve(params.resourcePath) !==
    path.resolve(
      store.resolvePath(path.join(params.sessionsDir, safeSessionName(expected.sessionId))),
    )
  )
    return { status: 'retained', reason: 'owner-mismatch' };
  const controller = new AbortController();
  const signal = AbortSignal.any([params.scope.signal, controller.signal]);
  const scope = { ...params.scope, signal };
  const timer = setTimeout(() => controller.abort(), params.perRecordDeadlineMs ?? 5000);
  timer.unref?.();
  try {
    return await withDurableCaptureResourceFence({
      store,
      resourcePath: params.resourcePath,
      expected: expected.fence,
      onCompleted: () => ({ status: 'retained' as const, reason: 'record-completed' }),
      run: async (lease) => {
        if (
          lease.envelope.sessionId !== expected.sessionId ||
          !sameDeviceIdentity(lease.envelope.device, expected.device) ||
          !sameRuntimeOwner(lease.envelope.owner, expected.owner)
        )
          return { status: 'retained' as const, reason: 'owner-mismatch' };
        let control: Awaited<ReturnType<typeof acquireScreenRecordingRecoveryControl>> | undefined;
        try {
          signal.throwIfAborted();
          control = await acquireScreenRecordingRecoveryControl(
            params.gateway,
            lease.envelope,
            scope,
          );
          const outcome = await control.reattach(lease.envelope);
          if (signal.aborted) {
            if (outcome.status === 'export') await outcome.handle[Symbol.asyncDispose]();
            return { status: 'retained' as const, reason: 'preservation-cancelled' };
          }
          switch (outcome.status) {
            case 'active': {
              if (!outcome.handle.settleForExport)
                return { status: 'retained' as const, reason: 'preservation-unavailable' };
              const settled = await outcome.handle.settleForExport(
                createStopProgress(lease),
                signal,
              );
              return {
                status: 'retained' as const,
                reason: signal.aborted
                  ? 'preservation-cancelled'
                  : settled.status === 'export'
                    ? 'export-pending'
                    : settled.reason,
              };
            }
            case 'export':
              await outcome.handle[Symbol.asyncDispose]();
              return { status: 'retained' as const, reason: 'export-pending' };
            case 'unreattachable':
              return { status: 'retained' as const, reason: outcome.reason };
            case 'missing':
              return { status: 'retained' as const, reason: 'resource-missing' };
            case 'completed':
              return { status: 'retained' as const, reason: 'completion-pending' };
          }
        } finally {
          if (control) await control[Symbol.asyncDispose]();
        }
      },
    });
  } catch (error) {
    return {
      status: 'retained',
      reason: signal.aborted
        ? 'preservation-cancelled'
        : error instanceof AppError && error.details?.reason === 'ownership-fence-lost'
          ? 'ownership-fence-lost'
          : 'preservation-failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function acquireScreenRecordingRecoveryControl(
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>,
  envelope: DurableResourceEnvelope<'screen-recording'>,
  scope: PlatformRequestScope,
): Promise<
  DurableCaptureRecoveryControl<
    'screen-recording',
    ScreenRecordingLiveHandle,
    ScreenRecordingCompletion
  >
> {
  return await acquireExactDurableCaptureRecoveryControl({
    gateway,
    envelope,
    scope,
    create: (binding) =>
      createScreenRecordingRecoveryControl({
        runtime: narrowDeviceBinding(binding, screenRecordingRecoveryUse),
        dispose: async () => await binding[Symbol.asyncDispose](),
      }),
  });
}

export function createScreenRecordingRecoveryControl(params: {
  runtime: ScreenRecordingRecoveryRuntime;
  dispose(): Promise<void>;
}): DurableCaptureRecoveryControl<
  'screen-recording',
  ScreenRecordingLiveHandle,
  ScreenRecordingCompletion
> {
  return Object.freeze({
    reattach: async (resource: DurableResourceEnvelope<'screen-recording'>) => {
      const outcome = await params.runtime.operations.screenRecordingReattach({
        envelope: resource,
      });
      return outcome.status === 'missing'
        ? { status: 'unreattachable' as const, reason: 'resource-missing' as const }
        : outcome;
    },
    cleanup: async (resource: DurableResourceEnvelope<'screen-recording'>) =>
      await params.runtime.operations.screenRecordingCleanup({ envelope: resource }),
    [Symbol.asyncDispose]: params.dispose,
  });
}
