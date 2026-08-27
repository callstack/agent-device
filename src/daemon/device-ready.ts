import type { DeviceInfo } from '@agent-device/kernel/device';
import { ensureLocalPlatformDeviceReady } from '../platform-runtime-device-ready.ts';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import { createTtlMemo } from '../utils/ttl-memo.ts';

// Exported so unit tests can assert TTL behavior without duplicating the value.
export const DEVICE_READY_CACHE_TTL_MS = 5_000;

const readyCache = createTtlMemo<string, true>({ ttlMs: DEVICE_READY_CACHE_TTL_MS });

export type DeviceReadyOptions = {
  deviceHub?: boolean;
  focusExisting?: boolean;
  onIosSimulatorColdBootStart?: (device: DeviceInfo) => void;
};

export async function ensureDeviceReady(
  device: DeviceInfo,
  options: DeviceReadyOptions = {},
): Promise<void> {
  if (isActiveProviderDevice(device)) return;

  const cacheKey = deviceReadyCacheKey(device);
  const isCached = readyCache.get(cacheKey) === true;
  if (isCached) {
    if (!options.focusExisting) return;
    readyCache.delete(cacheKey);
  }

  const handled = await ensureLocalPlatformDeviceReady(device, options);
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
