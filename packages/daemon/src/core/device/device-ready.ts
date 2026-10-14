import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonPlatformServices } from '../platform-services.ts';
import { isActiveProviderDevice } from '../provider-device-admission.ts';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

// Exported so unit tests can assert TTL behavior without duplicating the value.
export const DEVICE_READY_CACHE_TTL_MS = 5_000;

const readyCache = createTtlMemo<string, true>({ ttlMs: DEVICE_READY_CACHE_TTL_MS });

/**
 * Local readiness for one admitted device. The provider-ownership check and the scoped TTL cache
 * stay here; the concrete mechanics arrive through the request's platform-services port, so this
 * module names no platform and loads none.
 */
export async function ensureDeviceReady(
  device: DeviceInfo,
  platformServices: DaemonPlatformServices,
): Promise<void> {
  if (isActiveProviderDevice(device)) return;

  const cacheKey = deviceReadyCacheKey(device);
  if (readyCache.get(cacheKey) === true) return;

  const handled = await platformServices.ensureLocalDeviceReady(device);
  if (handled) {
    markDeviceReady(cacheKey);
  }
}

function markDeviceReady(cacheKey: string): void {
  readyCache.set(cacheKey, true);
}

function deviceReadyCacheKey(device: DeviceInfo): string {
  const simulatorSetPath = device.kind === 'simulator' ? (device.simulatorSetPath ?? '') : '';
  return JSON.stringify([
    device.platform,
    device.kind,
    device.id,
    device.target ?? '',
    simulatorSetPath,
  ]);
}
