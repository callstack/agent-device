import type {
  AudioProbeCompletion,
  AudioProbeLiveHandle,
} from '@agent-device/contracts/audio-probe-runtime';
import { audioProbeRecoveryUse } from '@agent-device/contracts/audio-runtime-plan';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import {
  type BoundDeviceRuntime,
  type DeviceRuntimeGateway,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { audioProbeDurableResource } from './audio-probe-session-resource.ts';
import type { DurableCaptureRecoveryControl } from './durable-capture-recovery-authority.ts';
import { acquireExactDurableCaptureRecoveryControl } from './durable-capture-runtime-recovery.ts';
import type { DurableCaptureRecoveryDiagnostic } from './durable-capture-resource-recovery.ts';

type AudioProbeRecoveryRuntime = BoundDeviceRuntime<typeof audioProbeRecoveryUse>;

export function recoverAudioProbeResourceAfterDaemonLock(params: {
  sessionsDir: string;
  resourcePath: string;
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  perRecordDeadlineMs?: number;
  onDiagnostic?: (diagnostic: DurableCaptureRecoveryDiagnostic) => void;
}) {
  return audioProbeDurableResource.recoverOne(
    {
      sessionsDir: params.sessionsDir,
      scope: params.scope,
      perRecordDeadlineMs: params.perRecordDeadlineMs,
      onDiagnostic: params.onDiagnostic,
      acquireControl: async (envelope, scope) =>
        await acquireAudioProbeRecoveryControl(params.gateway, envelope, scope),
    },
    params.resourcePath,
  );
}

async function acquireAudioProbeRecoveryControl(
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>,
  envelope: DurableResourceEnvelope<'audio-probe'>,
  scope: PlatformRequestScope,
): Promise<
  DurableCaptureRecoveryControl<'audio-probe', AudioProbeLiveHandle, AudioProbeCompletion>
> {
  return await acquireExactDurableCaptureRecoveryControl({
    gateway,
    envelope,
    scope,
    create: (binding) =>
      createAudioProbeRecoveryControl({
        runtime: narrowDeviceBinding(binding, audioProbeRecoveryUse),
        dispose: async () => await binding[Symbol.asyncDispose](),
      }),
  });
}

function createAudioProbeRecoveryControl(params: {
  runtime: AudioProbeRecoveryRuntime;
  dispose(): Promise<void>;
}): DurableCaptureRecoveryControl<'audio-probe', AudioProbeLiveHandle, AudioProbeCompletion> {
  return Object.freeze({
    reattach: async (resource: DurableResourceEnvelope<'audio-probe'>) =>
      await params.runtime.operations.audioProbeReattach({ envelope: resource }),
    cleanup: async (resource: DurableResourceEnvelope<'audio-probe'>) =>
      await params.runtime.operations.audioProbeCleanup({ envelope: resource }),
    [Symbol.asyncDispose]: params.dispose,
  });
}
