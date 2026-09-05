import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { deviceIdentity, deviceIdentityKey, type DeviceInfo } from '@agent-device/kernel/device';
import {
  sameRuntimeOwner,
  type DeviceBindingIntent,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { ManagedCommandHorizon, ManagedLeaseAdmission } from './lease-admission.ts';

export type ManagedRequestLease = Readonly<{
  lease: ManagedLeaseAdmission;
  horizon: ManagedCommandHorizon;
}>;
export type ResolveManagedRequestLease = (
  device: DeviceInfo,
  intent: Extract<DeviceBindingIntent, { kind: 'exact-owner' }>,
) => ManagedRequestLease | undefined;

export function createManagedRequestAdmission(params: {
  device: DeviceInfo;
  intent: Extract<DeviceBindingIntent, { kind: 'exact-owner' }>;
  scope: PlatformRequestScope;
  lifetime: AbortSignal;
  resolve?: ResolveManagedRequestLease;
}) {
  const configured = params.resolve?.(params.device, params.intent);
  if (
    !configured ||
    !sameRuntimeOwner(configured.lease.owner, params.intent.owner) ||
    configured.lease.fence.token !== params.intent.fence.token ||
    configured.lease.fence.generation !== params.intent.fence.generation ||
    deviceIdentityKey(deviceIdentity(configured.lease.reachability.device)) !==
      deviceIdentityKey(deviceIdentity(params.device)) ||
    configured.lease.reachability.device.simulatorSetPath !== params.device.simulatorSetPath
  ) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Managed binding has no matching lease admission.',
      {
        reason: 'managed-lease-admission-unavailable',
      },
    );
  }
  const { lease, horizon } = configured;
  const signal = AbortSignal.any([params.scope.signal, params.lifetime]);
  let active = false;
  const runConfirmed = async <T>(task: () => Promise<T>): Promise<T> => {
    const result = await lease.run(horizon, signal, task);
    if (result.status === 'admitted') return result.value;
    if (result.status === 'abandoned') throw createRequestCanceledError();
    throw new AppError('COMMAND_FAILED', 'Managed lease does not authorize execution.', {
      ...result,
      reason:
        result.status === 'teardown-required'
          ? 'managed-lease-teardown-required'
          : 'managed-command-deadline-exceeded',
      retriable: false,
    });
  };
  const admit = async <T>(task: () => Promise<T>): Promise<T> => {
    if (!active)
      throw new AppError('COMMAND_FAILED', 'Managed request is not admitted.', {
        reason: 'managed-request-not-admitted',
      });
    return await runConfirmed(task);
  };
  const ensureReady = async () => await admit(async () => {});
  const managedDevice = Object.freeze({
    device: lease.reachability.device,
    owner: lease.owner,
    fence: lease.fence,
    admit,
    run: lease.reachability.run,
  });
  return {
    scope: { ...params.scope, managedDevice },
    bind: runConfirmed,
    activate: () => {
      if (signal.aborted) throw createRequestCanceledError();
      active = true;
    },
    ensureReady,
  };
}
