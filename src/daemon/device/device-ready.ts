import type { DeviceInfo } from '@agent-device/kernel/device';
import { ensureLocalPlatformDeviceReady } from '../../platform-runtime-device-ready.ts';
import { isActiveProviderDevice } from '../provider-device-admission.ts';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

// Exported so unit tests can assert TTL behavior without duplicating the value.
export const DEVICE_READY_CACHE_TTL_MS = 5_000;

const readyCache = createTtlMemo<string, true>({ ttlMs: DEVICE_READY_CACHE_TTL_MS });

export async function ensureDeviceReady(device: DeviceInfo): Promise<void> {
  if (isActiveProviderDevice(device)) return;

  const cacheKey = deviceReadyCacheKey(device);
  if (readyCache.get(cacheKey) === true) return;

  const handled = await ensureLocalPlatformDeviceReady(device);
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
