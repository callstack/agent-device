import type { JsonObject } from './json.ts';

/**
 * agent-device's own interface to a managed-device allocator (ADR 0021 §3): lease request,
 * lookup, supersession, cancellation, renewal, release, identity status, activation confirmation,
 * and removal acknowledgement. The vocabulary matches the allocator's published contract so the
 * two sides cannot drift, but the interface is owned here — no allocator package is a dependency,
 * and the foundations implement it only as a scripted fake.
 */

/** The allocator's platform vocabulary; the daemon maps its own device families onto it. */
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

/** The typed reach projection of a lease's otherwise opaque environment record. */
export type ManagedLeaseEnvironment =
  | Readonly<{ platform: 'ios'; deviceSetPath: string }>
  | Readonly<{ platform: 'android'; adbServerPort: number }>;

/** A grant whose platform scoping key is absent or unparsable is unusable, not merely degraded. */
export type LeaseEnvironmentError = Readonly<{
  code: 'LEASE_ENVIRONMENT_INVALID';
  platform: ManagedLeasePlatform;
  key: ManagedLeaseEnvironmentKey;
}>;

export type ManagedLeaseEnvironmentOutcome =
  | Readonly<{ ok: true; environment: ManagedLeaseEnvironment }>
  | Readonly<{ ok: false; error: LeaseEnvironmentError }>;

/** One granted managed-device lease. `environment` stays the allocator's raw record. */
export type ManagedLease = Readonly<{
  id: string;
  ttlDeadline: number;
  device: Readonly<{ address: string }>;
  environment: Readonly<Record<string, string>>;
}>;

/**
 * One created managed identity. The incarnation id is minted before the device exists and is
 * preserved across reuse of the same Android identity, so it names the identity's creation rather
 * than the request that happens to be holding it.
 */
export type ManagedIdentityRef = Readonly<{ deviceId: string; identityIncarnationId: string }>;

export type ManagedIdentityState =
  | 'reserved'
  | 'active'
  | 'idle'
  | 'removing'
  | 'removed'
  | 'unknown';

export type ManagedIdentityStatus = ManagedIdentityRef & Readonly<{ state: ManagedIdentityState }>;

/**
 * Fail-fast admission (ADR 0021 §4): the allocator refuses instead of queueing and agent-device
 * adds no second queue. `activation: 'external-fence'` is the reusable-identity handshake, where
 * the allocator validates its clean baseline under the requester's fence before publishing the
 * grant; `'direct'` publishes as soon as the identity is ready.
 */
export type LeaseRequestInput = Readonly<{
  requesterId: string;
  requestGeneration: number;
  attemptKey: string;
  shape: ManagedShapeRequest;
  deadlineAtMs: number;
  admission: 'fail-fast';
  activation: 'direct' | 'external-fence';
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

export type LeaseRequestState =
  | 'pending'
  | 'granted'
  | 'refused'
  | 'superseded'
  | 'cancelled'
  | 'unknown';

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

/** One attempt on one requester's allocation lane. */
export type LeaseRequestRef = Readonly<{ requesterId: string; attemptKey: string }>;

/** Supersession replaces exactly the expected prior generation, never a newer one. */
export type SupersedeLeaseRequestInput = Readonly<{
  requesterId: string;
  expectedRequestGeneration: number;
  replacement: LeaseRequestInput;
}>;

/** Activation binds one request to one identity, so it is scoped to all three ids. */
export type LeaseActivationProof = Readonly<{
  requesterId: string;
  requestGeneration: number;
  identityIncarnationId: string;
}>;

export type ManagedDeviceAllocatorPort = Readonly<{
  instanceId: string;
  requestLease(input: LeaseRequestInput): Promise<LeaseRequestStatus>;
  getLeaseRequestStatus(request: LeaseRequestRef): Promise<LeaseRequestStatus>;
  supersedeLeaseRequest(input: SupersedeLeaseRequestInput): Promise<LeaseRequestStatus>;
  cancelLeaseRequest(request: LeaseRequestRef): Promise<LeaseRequestStatus>;
  renewLease(input: Readonly<{ leaseId: string; ttlDeadline: number }>): Promise<ManagedLease>;
  releaseLease(input: Readonly<{ leaseId: string }>): Promise<void>;
  confirmLeaseActivation(proof: LeaseActivationProof): Promise<void>;
  getManagedIdentityStatus(identity: ManagedIdentityRef): Promise<ManagedIdentityStatus>;
  acknowledgeManagedIdentityRemoval(identity: ManagedIdentityRef): Promise<void>;
  /**
   * The one reader of a grant's environment record. It is not a call to the allocator: the record
   * arrives with the lease, and the platform whose key must be present comes from the request.
   */
  readLeaseEnvironment(
    input: Readonly<{ platform: ManagedLeasePlatform; lease: ManagedLease }>,
  ): ManagedLeaseEnvironmentOutcome;
}>;
