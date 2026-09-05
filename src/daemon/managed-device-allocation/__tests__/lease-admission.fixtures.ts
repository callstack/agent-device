import type {
  LeaseRequestStatus,
  ManagedLease,
} from '@agent-device/contracts/managed-device-allocation';
import { Deadline } from '@agent-device/host-kit/retry';
import { createManagedLeaseReachability } from '../../../managed-device-reachability.ts';
import { createScriptedManagedDeviceAllocator } from '../../../__tests__/test-utils/managed-device-allocator.fixtures.ts';
import { createManagedLeaseAdmission } from '../lease-admission.ts';
import { ALLOCATION_GRANTED_STATUS, ALLOCATION_LEASE } from './fixtures.ts';

export const NOW = 1_700_000_000_000;
export const controller = () => new AbortController();
export const horizon = (milliseconds = 10_000) => ({
  deadline: Deadline.fromTimeoutMs(milliseconds),
  teardownTimeoutMs: 5_000,
});
export const renewedLease = (overrides: Partial<ManagedLease> = {}): ManagedLease => ({
  ...ALLOCATION_LEASE,
  ttlDeadline: NOW + 100_000,
  ...overrides,
});
export const granted = (overrides: Partial<LeaseRequestStatus> = {}): LeaseRequestStatus => ({
  ...ALLOCATION_GRANTED_STATUS,
  lease: renewedLease(),
  ...overrides,
});
export const unknownStatus: LeaseRequestStatus = {
  ...ALLOCATION_GRANTED_STATUS,
  state: 'unknown',
  lease: undefined,
};

export function setupAdmission(
  options: {
    grant?: LeaseRequestStatus;
    script?: NonNullable<Parameters<typeof createScriptedManagedDeviceAllocator>[0]>['script'];
    safetyWindowMs?: number;
  } = {},
) {
  const grant = options.grant ?? granted({ lease: renewedLease({ ttlDeadline: NOW + 5_000 }) });
  if (!grant.lease) throw new Error('Fixture needs a lease');
  const allocator = createScriptedManagedDeviceAllocator({ script: options.script });
  const reachability = createManagedLeaseReachability({ platform: 'ios', lease: grant.lease });
  const admission = createManagedLeaseAdmission({
    allocator,
    grant,
    reachability,
    renewalSafetyWindowMs: options.safetyWindowMs ?? 5_000,
  });
  return { allocator, admission, grant, reachability };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
