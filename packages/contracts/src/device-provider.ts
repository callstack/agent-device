// The device-provider port.
//
// A provider adapter (`providers/`, `cloud-webdriver/`) implements these; the daemon calls
// them. Both sides therefore name the same shapes, and since the adapters sit below the
// daemon in the spine, the shapes have to be declared below both — here — rather than
// inside the daemon module that happens to consume them first.

import type { DeviceInfo } from '@agent-device/kernel/device';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import type { DeviceInventoryRequest } from './device-inventory.ts';

export type DeviceLease = {
  leaseId: string;
  tenantId: string;
  runId: string;
  backend: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  createdAt: number;
  heartbeatAt: number;
  expiresAt: number;
};

export type LeaseLifecycleContext = {
  flags?: Readonly<Record<string, unknown>>;
  cwd?: string;
};

export type LeaseLifecycleProvider = {
  allocate?: (
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ) => Promise<Record<string, unknown> | undefined>;
  heartbeat?: (
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ) => Promise<Record<string, unknown> | undefined>;
  release?: (
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ) => Promise<Record<string, unknown> | undefined>;
};

export type DeviceInventoryProvider = (
  request: DeviceInventoryRequest,
) => Promise<DeviceInfo[] | null | undefined>;
