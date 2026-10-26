import type { JsonObject } from './json.ts';

/**
 * agent-device's own interface to a managed-device allocator (ADR 0021 §4): lease request,
 * lookup, cancellation, renewal, and release. The vocabulary matches the allocator's published contract so the
 * two sides cannot drift, but the interface is owned here — no allocator package is a dependency,
 * and the foundations implement it only as a scripted fake.
 */

/** The allocator's platform vocabulary. */
export type ManagedLeasePlatform = 'ios' | 'android';

/** A managed shape (ADR 0021 §5). The allocator owns canonical resolution against its catalog. */
export type ManagedShapeRequest = Readonly<{
  platform: ManagedLeasePlatform;
  deviceType: string;
  osVersion?: string;
}>;

/**
 * The per-platform key a grant must carry for its device to be reachable. Each is a versioned
 * driver contract on the allocator side, so the names are pinned as a type rather than restated
 * as free strings wherever a lease is read.
 */
export type ManagedLeaseEnvironmentKey = 'SIMLOCK_IOS_DEVICE_SET' | 'ANDROID_ADB_SERVER_PORT';

/**
 * The typed reach projection of a lease's otherwise opaque environment record, and the failure a
 * grant without its platform's key is.
 */
export type ManagedLeaseEnvironment =
  | Readonly<{ platform: 'ios'; deviceSetPath: string }>
  | Readonly<{ platform: 'android'; adbServerPort: number }>;

export type LeaseEnvironmentError = Readonly<{
  code: 'LEASE_ENVIRONMENT_INVALID';
  platform: ManagedLeasePlatform;
  key: ManagedLeaseEnvironmentKey;
}>;

/** One granted managed-device lease. `environment` stays the allocator's raw record. */
export type ManagedLease = Readonly<{
  id: string;
  ttlDeadline: number;
  device: Readonly<{ address: string }>;
  environment: Readonly<Record<string, string>>;
}>;

/**
 * Fail-fast admission (ADR 0021 §4): the allocator refuses instead of queueing and agent-device
 * adds no second queue.
 */
export type LeaseRequestInput = Readonly<{
  requesterId: string;
  requestGeneration: number;
  attemptKey: string;
  shape: ManagedShapeRequest;
  deadlineAtMs: number;
  admission: 'fail-fast';
  attribution?: JsonObject;
  /** Abandons only this caller's wait; the attempt keeps its own terminal outcome. */
  signal?: AbortSignal;
}>;

export type LeaseRefusalReason =
  | 'simulator-capacity'
  | 'disk-low'
  | 'invalid-shape'
  | 'preparation-required'
  | 'requester-busy';

/** A refusal is terminal for its attempt key; only a capacity refusal names a retry delay. */
export type LeaseRefusal = Readonly<{
  reason: LeaseRefusalReason;
  retryAfterMs?: number;
  message?: string;
}>;

export type LeaseRequestState = 'pending' | 'granted' | 'refused' | 'cancelled' | 'unknown';

/**
 * All three identities are readable from one status because the managed binding fence is derived
 * from them. `identityIncarnationId` is present from the moment an identity is reserved, so it is
 * absent only while the request has not reached one.
 */
export type LeaseRequestStatus = Readonly<{
  requesterId: string;
  requestGeneration: number;
  identityIncarnationId?: string;
  attemptKey: string;
  state: LeaseRequestState;
  lease?: ManagedLease;
  refusal?: LeaseRefusal;
}>;

/**
 * One attempt on one requester's allocation lane. It carries the generation so an allocator can
 * answer for an attempt it holds no record of with a status that names the attempt exactly.
 */
export type LeaseRequestRef = Readonly<{
  requesterId: string;
  requestGeneration: number;
  attemptKey: string;
}>;

export type ManagedDeviceAllocatorPort = Readonly<{
  instanceId: string;
  requestLease(input: LeaseRequestInput): Promise<LeaseRequestStatus>;
  getLeaseRequestStatus(request: LeaseRequestRef): Promise<LeaseRequestStatus>;
  cancelLeaseRequest(request: LeaseRequestRef): Promise<LeaseRequestStatus>;
  renewLease(input: Readonly<{ leaseId: string; ttlDeadline: number }>): Promise<ManagedLease>;
  releaseLease(input: Readonly<{ leaseId: string }>): Promise<void>;
}>;
