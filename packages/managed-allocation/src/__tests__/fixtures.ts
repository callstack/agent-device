import type {
  LeaseRequestInput,
  LeaseRequestStatus,
  ManagedIdentityRef,
  ManagedLease,
  ManagedShapeRequest,
} from '@agent-device/contracts/managed-device-allocation';

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

export const ALLOCATION_PENDING_STATUS: LeaseRequestStatus = {
  requesterId: ALLOCATION_REQUEST.requesterId,
  requestGeneration: ALLOCATION_REQUEST.requestGeneration,
  attemptKey: ALLOCATION_REQUEST.attemptKey,
  state: 'pending',
};

export const ALLOCATION_GRANTED_STATUS: LeaseRequestStatus = {
  ...ALLOCATION_PENDING_STATUS,
  identityIncarnationId: ALLOCATION_IDENTITY.identityIncarnationId,
  state: 'granted',
  lease: ALLOCATION_LEASE,
};

export const ALLOCATION_REFUSED_STATUS: LeaseRequestStatus = {
  ...ALLOCATION_PENDING_STATUS,
  state: 'refused',
  refusal: { reason: 'simulator-capacity', retryAfterMs: 30_000 },
};
