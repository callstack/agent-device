import type { HumanControlHold, HumanControlHoldScope } from '@agent-device/contracts/client';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { AllocateLeaseRequest } from '../lease-registry-scope.ts';
import type { DaemonRequest } from '../types.ts';
import { AppError } from '@agent-device/kernel/errors';

export const HUMAN_CONTROL_SCOPE: HumanControlHoldScope = {
  backend: 'ios-instance',
  leaseProvider: 'proxy',
  deviceKey: 'ios:mobile:sim-1',
};

export const HUMAN_CONTROL_LEASE_REQUEST: AllocateLeaseRequest = {
  tenantId: 'tenant-a',
  runId: 'run-a',
  clientId: 'client-a',
  leaseBackend: HUMAN_CONTROL_SCOPE.backend,
  leaseProvider: HUMAN_CONTROL_SCOPE.leaseProvider,
  deviceKey: HUMAN_CONTROL_SCOPE.deviceKey,
};

export const HUMAN_CONTROL_HOLD: HumanControlHold = {
  id: 'operator-1',
  scope: HUMAN_CONTROL_SCOPE,
  state: 'active',
  reason: 'Manual inspection',
  createdAt: 1_000,
  updatedAt: 1_000,
  expiresAt: 16_000,
};

export function humanControlRequest(
  lease: DeviceLease,
  command = 'human_control',
  positionals = ['list'],
): DaemonRequest {
  return {
    token: 'test-token',
    session: 'takeover-test',
    command,
    positionals,
    flags: {},
    meta: {
      sessionIsolation: 'tenant',
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseId: lease.leaseId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      deviceKey: lease.deviceKey,
      clientId: lease.clientId,
    },
  };
}

export function isHumanControlError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'DEVICE_IN_USE' &&
    error.details?.reason === 'human_control_active'
  );
}

export function createControlLatch() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
