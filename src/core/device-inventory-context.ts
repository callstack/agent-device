import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import type {
  DeviceInventoryDiscovery,
  DeviceInventoryGateway,
  ProviderAwareDeviceInventoryGateway,
} from '@agent-device/contracts/platform-module';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AsyncLocalStorage } from 'node:async_hooks';

const DEVICE_INVENTORY_CONTEXT_UNAVAILABLE_REASON = 'device_inventory_context_unavailable';

type DeviceInventoryContext = Readonly<{
  providerFirst: ProviderAwareDeviceInventoryGateway;
  localOnly: DeviceInventoryGateway;
  requestScope: PlatformRequestScope;
}>;

const deviceInventoryContext = new AsyncLocalStorage<DeviceInventoryContext>();

export async function withDeviceInventoryContext<T>(
  context: DeviceInventoryContext,
  task: () => Promise<T>,
): Promise<T> {
  return await deviceInventoryContext.run(context, task);
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
      { reason: DEVICE_INVENTORY_CONTEXT_UNAVAILABLE_REASON },
    );
  }
  return context;
}

/** Control-flow and composition failures that a best-effort inventory probe must never hide. */
export function shouldPropagateDeviceInventoryProbeError(error: unknown): boolean {
  if (isRequestCanceledError(error)) return true;
  if (
    error instanceof AppError &&
    error.code === 'COMMAND_FAILED' &&
    error.details?.reason === DEVICE_INVENTORY_CONTEXT_UNAVAILABLE_REASON
  ) {
    return true;
  }
  return error instanceof Error && error.name === 'AbortError';
}
