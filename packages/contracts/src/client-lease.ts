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
  createdAt?: number;
  heartbeatAt?: number;
  expiresAt?: number;
};

export type LeaseOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    ttlMs?: number;
  };

export type LeaseAllocateOptions = LeaseOptions & {
  tenant: string;
  runId: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  provider?: string;
  deviceKey?: string;
  clientId?: string;
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
