// The device-provider port.
//
// A provider adapter (`providers/`, `@agent-device/provider-webdriver`) implements these; the daemon calls
// them. Both sides therefore name the same shapes, and since the adapters sit below the
// daemon in the spine, the shapes have to be declared below both — here — rather than
// inside the daemon module that happens to consume them first.

import type { DeviceInfo } from '@agent-device/kernel/device';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import type { ProviderDeviceInventoryRequest } from './device-inventory.ts';

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
  initialApp?: string;
  cwd?: string;
  publicNetworkOnly?: boolean;
  /** Request-bound cancellation (explicit cancel or client disconnect). */
  signal?: AbortSignal;
  /**
   * Epoch-ms deadline by which `allocate` must have settled; derived from the
   * same budget as the client's `lease_allocate` envelope, so a provider that
   * fits its remote phases within it is never abandoned by a client first.
   */
  deadline?: number;
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
  request: ProviderDeviceInventoryRequest,
  signal?: AbortSignal,
) => Promise<DeviceInfo[] | null | undefined>;

export type ProviderDeviceInventoryOutcome =
  | Readonly<{ kind: 'declined' }>
  | Readonly<{ kind: 'inventory'; devices: readonly DeviceInfo[] }>;

/** Closed provider-owned inventory source; an empty inventory is authoritative. */
export type ProviderDeviceInventorySource = Readonly<{
  discover(
    request: Readonly<ProviderDeviceInventoryRequest>,
    signal: AbortSignal,
  ): Promise<ProviderDeviceInventoryOutcome>;
}>;

export type ProviderAppCatalogQuery = Readonly<{
  provider: string;
  platform: 'android' | 'ios';
  publicNetworkOnly?: boolean;
}>;

export type ProviderAppCatalogHandler = (
  query: ProviderAppCatalogQuery,
  signal?: AbortSignal,
) => Promise<readonly string[]>;

export type ProviderAppCatalog = Readonly<{
  supports(provider: string): boolean;
  list: ProviderAppCatalogHandler;
}>;
