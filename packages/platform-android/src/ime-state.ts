import type { DeviceInfo } from '@agent-device/kernel/device';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { getAndroidImeHelperDeviceKey } from './ime-helper.ts';

// Process-lived test-IME ownership state, shared by activation, restore, and startup recovery.

// Per-daemon-process cache of devices with the test IME active; input-actions.ts reads this to
// route text entry through the broadcast channel.
export const activeTestImeDevices = new Set<string>();

const androidTestImeRecoveryLocks = new Map<string, Promise<unknown>>();

export function isAndroidTestImeActive(device: DeviceInfo): boolean {
  return activeTestImeDevices.has(getAndroidImeHelperDeviceKey(device));
}

export function withAndroidTestImeRecoveryLock<T>(
  stateDir: string,
  serial: string,
  task: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(androidTestImeRecoveryLocks, `${stateDir}:${serial}`, task);
}

/**
 * @internal Test isolation hook for the active test-IME device set.
 */
export function resetAndroidTestImeActivationCacheForTests(): void {
  activeTestImeDevices.clear();
}

/**
 * @internal Test seam to force the active test-IME state for a device.
 */
export function setAndroidTestImeActiveForTests(device: DeviceInfo, active: boolean): void {
  const key = getAndroidImeHelperDeviceKey(device);
  if (active) {
    activeTestImeDevices.add(key);
  } else {
    activeTestImeDevices.delete(key);
  }
}
