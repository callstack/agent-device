import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import {
  type BoundDeviceRuntime,
  type DeviceRuntimeGateway,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingLiveHandle,
} from '@agent-device/contracts/screen-recording-runtime';
import { screenRecordingRecoveryUse } from '@agent-device/contracts/screen-recording-runtime-plan';
import type { DurableCaptureRecoveryControl } from './durable-capture-recovery-authority.ts';
import { acquireExactDurableCaptureRecoveryControl } from './durable-capture-runtime-recovery.ts';
import type { DurableCaptureRecoveryDiagnostic } from './durable-capture-resource-recovery.ts';
import { screenRecordingDurableResource } from './screen-recording-session-resource.ts';

type ScreenRecordingRecoveryRuntime = BoundDeviceRuntime<typeof screenRecordingRecoveryUse>;

export function recoverScreenRecordingResourceAfterDaemonLock(params: {
  sessionsDir: string;
  resourcePath: string;
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  perRecordDeadlineMs?: number;
  onDiagnostic?: (diagnostic: DurableCaptureRecoveryDiagnostic) => void;
}) {
  return screenRecordingDurableResource.recoverOne(
    {
      sessionsDir: params.sessionsDir,
      scope: params.scope,
      perRecordDeadlineMs: params.perRecordDeadlineMs,
      onDiagnostic: params.onDiagnostic,
      acquireControl: async (envelope, scope) =>
        await acquireScreenRecordingRecoveryControl(params.gateway, envelope, scope),
    },
    params.resourcePath,
  );
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
    reattach: async (resource: DurableResourceEnvelope<'screen-recording'>) =>
      await params.runtime.operations.screenRecordingReattach({ envelope: resource }),
    cleanup: async (resource: DurableResourceEnvelope<'screen-recording'>) =>
      await params.runtime.operations.screenRecordingCleanup({ envelope: resource }),
    [Symbol.asyncDispose]: params.dispose,
  });
}
