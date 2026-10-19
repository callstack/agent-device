import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import { shutdownTargetUse } from '@agent-device/contracts/platform-runtime-operations';
import { publicPlatformString } from '@agent-device/kernel/device';
import { errorResponse } from '@agent-device/kernel/contracts';
import {
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
} from '../../resources/session-device-resolution.ts';
import {
  requireRuntimeBinding,
  requireRuntimeFacts,
  type RuntimeCommandHandlerParams,
} from '../../core/session-runtime-admission.ts';
import { deviceStatusReportResponse } from './session-device-status-response.ts';

function shutdownUnavailableResponse(fact: RuntimeOperationFact) {
  if (fact.available) return null;
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    'shutdown is supported only for Apple simulators and Android emulators.',
    undefined,
    fact.hint ? { hint: fact.hint } : undefined,
  );
}

function shutdownFailureMessage(shutdown: TargetShutdownResult): string {
  const message = shutdown.error?.message ?? shutdown.stderr.trim();
  return message.length > 0 ? message : 'Shutdown failed';
}

/**
 * Turns off the selected simulator/emulator without ending any session that uses it.
 * Refuses with `DEVICE_IN_USE` when the target is the active session's device;
 * that device is shut down via `close --shutdown` instead.
 */
export async function handleShutdownCommand(
  params: RuntimeCommandHandlerParams,
): Promise<DaemonResponse> {
  const activeSession = params.sessionStore.get(params.sessionName);
  const flags = params.req.flags ?? {};
  const guard = requireSessionOrExplicitSelector(params.req.command, activeSession, flags);
  if (guard) return guard;

  const device = await resolveCommandDevice({
    flags,
    session: activeSession,
    androidAvdSelection: 'include-stopped',
    platformServices: params.platformServices,
  });
  const inspectFacts = requireRuntimeFacts(params.inspectFacts);
  const facts = await inspectFacts(device);
  const unsupported = shutdownUnavailableResponse(facts.operations.shutdownTarget);
  if (unsupported) return unsupported;

  if (
    activeSession &&
    activeSession.device.platform === device.platform &&
    activeSession.device.id === device.id
  ) {
    return errorResponse(
      'DEVICE_IN_USE',
      'Cannot shut down an active session device directly. Use close --shutdown to end the session and turn off the simulator/emulator.',
      {
        hint: `Run agent-device close --shutdown --session ${params.sessionName}`,
        session: params.sessionName,
        platform: publicPlatformString(device),
        target: device.target ?? 'mobile',
        device: device.name,
        id: device.id,
        kind: device.kind,
      },
    );
  }

  const bindDevice = requireRuntimeBinding(params.bindDevice);
  const shutdown = await (await bindDevice(device, shutdownTargetUse)).operations.shutdownTarget();
  if (!shutdown.success) {
    return errorResponse(
      shutdown.error?.code ?? 'COMMAND_FAILED',
      shutdownFailureMessage(shutdown),
      {
        platform: publicPlatformString(device),
        target: device.target ?? 'mobile',
        device: device.name,
        id: device.id,
        kind: device.kind,
        shutdown,
      },
    );
  }

  return deviceStatusReportResponse(device, { shutdown });
}
