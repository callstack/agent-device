import { AppError, isRequestCanceledError, type ReasonTable } from '@agent-device/kernel/errors';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import type {
  ComposedDeviceInventoryGateways,
  DeviceInventoryDiscovery,
} from '@agent-device/contracts/platform-module';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Why the device-selection rule refuses to answer at all. */
const DEVICE_SELECTION_REASONS = {
  // Inventory was reached outside a request, so no request scope carries its gateways.
  contextUnavailable: { reason: 'device_inventory_context_unavailable' },
} as const satisfies ReasonTable<'device selection'>;

type DeviceInventoryContext = ComposedDeviceInventoryGateways &
  Readonly<{ requestScope: PlatformRequestScope }>;

const deviceInventoryContext = new AsyncLocalStorage<DeviceInventoryContext>();

export async function withDeviceInventoryContext<T>(
  context: DeviceInventoryContext,
  task: () => Promise<T>,
): Promise<T> {
  return await deviceInventoryContext.run(context, task);
}

/**
 * The composition root's installed-app probe, or undefined where no probe was installed:
 * device selection then falls back to the ordinary inventory rules instead of narrowing
 * by installed app.
 */
export function readInstalledAppProbe() {
  return deviceInventoryContext.getStore()?.findInstalledApp;
}

/** The composition root's app-device resolver, or undefined where none was installed. */
export function readAppDeviceResolver() {
  return deviceInventoryContext.getStore()?.resolveAppDevice;
}

export async function listDeviceInventory(request: DeviceInventoryRequest): Promise<DeviceInfo[]> {
  return await discoverFrom('providerFirst', request);
}

export async function readDeviceInventory(
  request: DeviceInventoryRequest,
): Promise<DeviceInventoryDiscovery> {
  const context = requiredContext();
  const result = await context.providerFirst.discoverWithSource(request, context.requestScope);
  return {
    devices: result.devices.map((device) => ({ ...device })),
    source: result.source,
  };
}

export async function listLocalDeviceInventory(
  request: DeviceInventoryRequest,
): Promise<DeviceInfo[]> {
  return await discoverFrom('localOnly', request);
}

async function discoverFrom(
  gateway: 'providerFirst' | 'localOnly',
  request: DeviceInventoryRequest,
): Promise<DeviceInfo[]> {
  const context = requiredContext();
  const devices = await context[gateway].discover(request, context.requestScope);
  return devices.map((device) => ({ ...device }));
}

function requiredContext(): DeviceInventoryContext {
  const context = deviceInventoryContext.getStore();
  if (!context) {
    throw new AppError(
      'COMMAND_FAILED',
      'Device inventory gateway is unavailable outside request execution',
      { reason: DEVICE_SELECTION_REASONS.contextUnavailable.reason },
    );
  }
  return context;
}

export function shouldPropagateDeviceInventoryProbeError(error: unknown): boolean {
  if (isRequestCanceledError(error)) return true;
  if (
    error instanceof AppError &&
    error.code === 'COMMAND_FAILED' &&
    error.details?.reason === DEVICE_SELECTION_REASONS.contextUnavailable.reason
  ) {
    return true;
  }
  return error instanceof Error && error.name === 'AbortError';
}
