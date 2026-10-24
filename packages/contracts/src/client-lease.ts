// The public API vocabulary for device lease allocation and cloud artifacts.

import type { LeaseBackend } from '@agent-device/kernel/contracts';
import type {
  AgentDeviceRequestOverrides,
  AgentDeviceSelectionOptions,
} from './client-connection.ts';

export type Lease = {
  leaseId: string;
  tenantId: string;
  runId: string;
  backend: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  /**
   * The device granted for a request that named a device spec, written by the backend that
   * honoured the spec. A daemon refuses a spec instead, so only such a backend sets it.
   */
  device?: LeaseDevice;
  /** Present when the daemon keeps this lease through session `close`; an older daemon omits it. */
  retainOnClose?: true;
  createdAt?: number;
  heartbeatAt?: number;
  expiresAt?: number;
};

/**
 * A device spec a lease request can name beside platform, target and device. Only a backend in
 * front of the daemon honours it; a daemon refuses every request that names one, with
 * `UNSUPPORTED_OPERATION` and `details.reason: 'device-spec-unsupported'`.
 */
export type LeaseDeviceSpec = {
  /** OS version or range, opaque to agent-device; the backend validates it. */
  osVersion?: string;
  /** Android system image tag, for example `google_apis_playstore`. */
  imageTag?: string;
  /** `true` asks for a physical device instead of a simulator or emulator. */
  physical?: boolean;
};

/** The device facts the backend granted for a {@link LeaseDeviceSpec}. */
export type LeaseDevice = {
  model: string;
  /** The exact OS version granted. */
  osVersion: string;
  imageTag?: string;
  physical: boolean;
};

/**
 * A session lease a daemon request ended. A reply to a request that ended leases lists them once in
 * `endedLeases` at response level: in `data` on success, in `error.details` on failure. A `close`,
 * a `batch` close step, a `replay` or `test` script's close, and `test` session cleanup each end the
 * lease they close with, unless it was allocated with `retainOnClose`. A daemon older than this
 * field omits it.
 */
export type EndedLease = { leaseId: string; outcome: 'released' };

export type LeaseOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    ttlMs?: number;
  };

export type LeaseAllocateOptions = LeaseOptions &
  LeaseDeviceSpec & {
    tenant: string;
    runId: string;
    /**
     * The id for the new lease (16-128 hex characters), refused when the daemon already issued it;
     * the client's configured `leaseId` is never sent here. Use the returned lease's `leaseId`: a daemon that predates this field mints its own,
     * and a run that already holds a lease gets that lease back.
     */
    leaseId?: string;
    leaseBackend?: LeaseBackend;
    leaseProvider?: string;
    provider?: string;
    deviceKey?: string;
    clientId?: string;
    /**
     * Keeps the lease through session `close`; it then ends only through `leases.release`, expiry, or
     * daemon shutdown. Asking for it on a lease the same client already holds for the run turns it on
     * for that lease; the returned lease's `retainOnClose` says whether the daemon honored it.
     */
    retainOnClose?: boolean;
  };

export type LeaseScopedOptions = LeaseOptions & {
  tenant?: string;
  runId?: string;
  leaseId: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  provider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type CloudArtifactsOptions = AgentDeviceRequestOverrides & {
  provider?: string;
  providerSessionId?: string;
};

export type HumanControlHoldScope = {
  backend: LeaseBackend;
  leaseProvider?: string;
  deviceKey: string;
};

export type HumanControlHold = {
  id: string;
  scope: HumanControlHoldScope;
  reason?: string;
  state: 'activating' | 'active';
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
};

export type HumanControlHoldOptions = {
  reason?: string;
  ttlMs?: number;
};
