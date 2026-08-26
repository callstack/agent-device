import type {
  PerfNativeCaptureCompletion,
  PerfNativeCaptureLiveHandle,
  PerfNativeCaptureRecoveryInput,
} from '@agent-device/contracts/perf-runtime';
import { perfNativeCaptureRecoveryUse } from '@agent-device/contracts/perf-runtime-plan';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import {
  type BoundDeviceRuntime,
  type DeviceRuntimeGateway,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { perfCaptureDurableResource } from './perf-capture-session-resource.ts';
import type { DurableCaptureRecoveryControl } from './durable-capture-recovery-authority.ts';
import { acquireExactDurableCaptureRecoveryControl } from './durable-capture-runtime-recovery.ts';
import type { DurableCaptureRecoveryDiagnostic } from './durable-capture-resource-recovery.ts';

type PerfCaptureRecoveryRuntime = BoundDeviceRuntime<typeof perfNativeCaptureRecoveryUse>;

export function recoverPerfCaptureResourceAfterDaemonLock(params: {
  sessionsDir: string;
  resourcePath: string;
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  perRecordDeadlineMs?: number;
  onDiagnostic?: (diagnostic: DurableCaptureRecoveryDiagnostic) => void;
}) {
  return perfCaptureDurableResource.recoverOne(
    {
      sessionsDir: params.sessionsDir,
      scope: params.scope,
      perRecordDeadlineMs: params.perRecordDeadlineMs,
      onDiagnostic: params.onDiagnostic,
      acquireControl: async (envelope, scope) =>
        await acquirePerfCaptureRecoveryControl(params.gateway, envelope, scope),
    },
    params.resourcePath,
  );
}

async function acquirePerfCaptureRecoveryControl(
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>,
  envelope: DurableResourceEnvelope<'perf-capture'>,
  scope: PlatformRequestScope,
): Promise<
  DurableCaptureRecoveryControl<
    'perf-capture',
    PerfNativeCaptureLiveHandle,
    PerfNativeCaptureCompletion
  >
> {
  return await acquireExactDurableCaptureRecoveryControl({
    gateway,
    envelope,
    scope,
    create: (binding) =>
      createPerfCaptureRecoveryControl({
        runtime: narrowDeviceBinding(binding, perfNativeCaptureRecoveryUse),
        dispose: async () => await binding[Symbol.asyncDispose](),
      }),
  });
}

function createPerfCaptureRecoveryControl(params: {
  runtime: PerfCaptureRecoveryRuntime;
  dispose(): Promise<void>;
}): DurableCaptureRecoveryControl<
  'perf-capture',
  PerfNativeCaptureLiveHandle,
  PerfNativeCaptureCompletion
> {
  return Object.freeze({
    reattach: async (resource: PerfNativeCaptureRecoveryInput['envelope']) =>
      await params.runtime.operations.perfNativeCaptureReattach({ envelope: resource }),
    cleanup: async (resource: PerfNativeCaptureRecoveryInput['envelope']) =>
      await params.runtime.operations.perfNativeCaptureCleanup({ envelope: resource }),
    [Symbol.asyncDispose]: params.dispose,
  });
}
