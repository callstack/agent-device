import {
  defineUse,
  narrowDeviceBinding,
  type AppLogCompletion,
  type AppLogLiveHandle,
  type DeviceRuntimeGateway,
  type DurableResourceEnvelope,
  type PlatformRequestScope,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import { appLogDurableResource } from './app-log-session-resource.ts';
import { acquireExactDurableCaptureRecoveryControl } from './durable-capture-runtime-recovery.ts';
import type { DurableCaptureRecoveryControl } from './durable-capture-recovery-authority.ts';
import type {
  DurableCaptureRecoveryDiagnostic,
  DurableCaptureRecoverySummary,
} from './durable-capture-resource-recovery.ts';

const appLogRecoveryUse = defineUse({
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
    ...buildAppLogRecoveryParams(params),
  });
}

export function recoverAppLogResourceAfterDaemonLock(params: {
  sessionsDir: string;
  resourcePath: string;
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  perRecordDeadlineMs?: number;
  onDiagnostic?: (diagnostic: AppLogRecoveryDiagnostic) => void;
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
  onDiagnostic?: (diagnostic: AppLogRecoveryDiagnostic) => void;
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
