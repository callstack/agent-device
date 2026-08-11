import {
  narrowDeviceBinding,
  runtimeUse,
  type AppLogCompletion,
  type AppLogLiveHandle,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type DurableResourceEnvelope,
  type PlatformRequestScope,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appLogDurableResource } from './app-log-session-resource.ts';
import type { DurableCaptureRecoveryControl } from './durable-capture-recovery-authority.ts';
import type {
  DurableCaptureRecoveryDiagnostic,
  DurableCaptureRecoverySummary,
} from './durable-capture-resource-recovery.ts';

const appLogRecoveryUse = runtimeUse<PlatformRuntimeOperations>()({
  required: ['appLogReattach', 'appLogCleanup'],
});

export type AppLogRecoverySummary = DurableCaptureRecoverySummary;
export type AppLogRecoveryDiagnostic = DurableCaptureRecoveryDiagnostic;

export function recoverAppLogResourcesAfterDaemonLock(params: {
  sessionsDir: string;
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  perRecordDeadlineMs?: number;
  onDiagnostic?: (diagnostic: AppLogRecoveryDiagnostic) => void;
}): Promise<AppLogRecoverySummary> {
  return appLogDurableResource.recoverAll({
    sessionsDir: params.sessionsDir,
    scope: params.scope,
    perRecordDeadlineMs: params.perRecordDeadlineMs,
    onDiagnostic: params.onDiagnostic,
    acquireControl: async (envelope, scope) =>
      await acquireAppLogRecoveryControl(params.gateway, envelope, scope),
  });
}

async function acquireAppLogRecoveryControl(
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>,
  envelope: DurableResourceEnvelope<'app-log'>,
  scope: PlatformRequestScope,
): Promise<DurableCaptureRecoveryControl<'app-log', AppLogLiveHandle, AppLogCompletion>> {
  let binding: DeviceBinding<PlatformRuntimeOperations> | undefined;
  try {
    binding = await gateway.bind({
      device: deviceFromEnvelope(envelope),
      intent: { kind: 'exact-owner', owner: envelope.owner, fence: envelope.fence },
      scope,
    });
    scope.signal.throwIfAborted();
    const runtime = narrowDeviceBinding(binding, appLogRecoveryUse);
    const bound = binding;
    return Object.freeze({
      reattach: async (resource: DurableResourceEnvelope<'app-log'>) =>
        await runtime.operations.appLogReattach({ envelope: resource }),
      cleanup: async (resource: DurableResourceEnvelope<'app-log'>) =>
        await runtime.operations.appLogCleanup({ envelope: resource }),
      [Symbol.asyncDispose]: async () => await bound[Symbol.asyncDispose](),
    });
  } catch (error) {
    if (binding) await binding[Symbol.asyncDispose]();
    throw error;
  }
}

function deviceFromEnvelope(envelope: DurableResourceEnvelope<'app-log'>): DeviceInfo {
  return {
    platform: envelope.device.family,
    id: envelope.device.id,
    name: envelope.device.id,
    kind: envelope.device.kind,
    ...(envelope.device.target === undefined ? {} : { target: envelope.device.target }),
    ...(envelope.device.appleOs === undefined ? {} : { appleOs: envelope.device.appleOs }),
    ...(envelope.device.iosPhysicalDeviceBackend === undefined
      ? {}
      : { iosPhysicalDeviceBackend: envelope.device.iosPhysicalDeviceBackend }),
  };
}
