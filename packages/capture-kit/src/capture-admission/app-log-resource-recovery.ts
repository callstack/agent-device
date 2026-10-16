import type { AppLogCompletion, AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import {
  type DeviceRuntimeGateway,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import {
  type PlatformRuntimeOperations,
  defineUse,
} from '@agent-device/contracts/platform-runtime-operations';
import type {
  DurableCaptureRecoveryControl,
  DurableCaptureRecoverySummary,
} from '../durable-capture/index.ts';
import type { ResourceDiagnostic } from '@agent-device/host-kit/diagnostics';
import { appLogDurableResource } from './app-log-durable-resource.ts';
import { acquireExactDurableCaptureRecoveryControl } from './durable-capture-runtime-recovery.ts';

const appLogRecoveryUse = defineUse({
  required: ['appLogReattach', 'appLogCleanup'],
});

export type AppLogRecoverySummary = DurableCaptureRecoverySummary;

export function recoverAppLogResourcesAfterDaemonLock(params: {
  sessionsDir: string;
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  perRecordDeadlineMs?: number;
  onDiagnostic?: (diagnostic: ResourceDiagnostic) => void;
}): Promise<AppLogRecoverySummary> {
  return appLogDurableResource.recoverAll({
    sessionsDir: params.sessionsDir,
    ...buildAppLogRecoveryParams(params),
  });
}

export function recoverAppLogResourceAfterDaemonLock(params: {
  sessionsDir: string;
  resourcePath: string;
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  perRecordDeadlineMs?: number;
  onDiagnostic?: (diagnostic: ResourceDiagnostic) => void;
}) {
  return appLogDurableResource.recoverOne(
    { sessionsDir: params.sessionsDir, ...buildAppLogRecoveryParams(params) },
    params.resourcePath,
  );
}

function buildAppLogRecoveryParams(params: {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  perRecordDeadlineMs?: number;
  onDiagnostic?: (diagnostic: ResourceDiagnostic) => void;
}) {
  return {
    scope: params.scope,
    perRecordDeadlineMs: params.perRecordDeadlineMs,
    onDiagnostic: params.onDiagnostic,
    acquireControl: async (
      envelope: DurableResourceEnvelope<'app-log'>,
      scope: PlatformRequestScope,
    ) => await acquireAppLogRecoveryControl(params.gateway, envelope, scope),
  };
}

async function acquireAppLogRecoveryControl(
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>,
  envelope: DurableResourceEnvelope<'app-log'>,
  scope: PlatformRequestScope,
): Promise<DurableCaptureRecoveryControl<'app-log', AppLogLiveHandle, AppLogCompletion>> {
  return await acquireExactDurableCaptureRecoveryControl({
    gateway,
    envelope,
    scope,
    create: (binding) => {
      const runtime = narrowDeviceBinding(binding, appLogRecoveryUse);
      return Object.freeze({
        reattach: async (resource: DurableResourceEnvelope<'app-log'>) =>
          await runtime.operations.appLogReattach({ envelope: resource }),
        cleanup: async (resource: DurableResourceEnvelope<'app-log'>) =>
          await runtime.operations.appLogCleanup({ envelope: resource }),
        [Symbol.asyncDispose]: async () => await binding[Symbol.asyncDispose](),
      });
    },
  });
}
