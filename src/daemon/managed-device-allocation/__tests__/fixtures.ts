import type {
  LeaseRequestInput,
  LeaseRequestStatus,
  ManagedIdentityRef,
  ManagedLease,
  ManagedShapeRequest,
} from '@agent-device/contracts/managed-device-allocation';

/**
 * The grant shapes the daemon-side managed admission is written against, stated in contract terms
 * only. `@agent-device/managed-allocation` keeps its own copy for the package's tests
 * (`packages/managed-allocation/src/__tests__/fixtures.ts`), the same way both sides keep their own
 * `managed-device-allocator.fixtures.ts`: neither tree reaches past the other's exported surface
 * for test data.
 */
const ALLOCATION_SHAPE: ManagedShapeRequest = {
  platform: 'ios',
  deviceType: 'iPhone 16',
  osVersion: '18.2',
};

const ALLOCATION_IDENTITY: ManagedIdentityRef = {
  deviceId: 'device-1',
  identityIncarnationId: 'incarnation-1',
};

export const ALLOCATION_LEASE: ManagedLease = {
  id: 'lease-1',
  ttlDeadline: 1_700_000_900_000,
  device: { address: ALLOCATION_IDENTITY.deviceId },
  environment: { SIMLOCK_IOS_DEVICE_SET: '/managed/set' },
};

export const ALLOCATION_REQUEST: LeaseRequestInput = {
  requesterId: 'requester-a',
  requestGeneration: 1,
  attemptKey: 'attempt-1',
  shape: ALLOCATION_SHAPE,
  deadlineAtMs: 1_700_000_600_000,
  admission: 'fail-fast',
  activation: 'direct',
  attribution: { tenantId: 'tenant-a' },
};

export const ALLOCATION_GRANTED_STATUS: LeaseRequestStatus = {
  requesterId: ALLOCATION_REQUEST.requesterId,
  requestGeneration: ALLOCATION_REQUEST.requestGeneration,
  attemptKey: ALLOCATION_REQUEST.attemptKey,
  identityIncarnationId: ALLOCATION_IDENTITY.identityIncarnationId,
  state: 'granted',
  lease: ALLOCATION_LEASE,
};
