import type { DeviceInfo } from '@agent-device/kernel/device';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { getAndroidImeHelperDeviceKey } from './ime-helper.ts';

// Process-lived test-IME ownership state, shared by activation, restore, and startup recovery.

export type AndroidTestImeOwnership = {
  /** The recovery scope whose lock and marker guard this device's IME. */
  readonly stateDir: string;
  /** A rebind left the helper unconfirmed; text must not reach it before a confirmed rebind. */
  rebindUnconfirmed: boolean;
};

// Per-device flush-settle windows left unfinished by an aborted close, keyed like the recovery
// lock (`${stateDir}:${serial}`) and valued with the deadline the settle must reach. The owned
// flag is dropped when a restore begins, so without this a cancelled close would let the next
// close of the same emulator take the no-record fast path and kill inside the flush window.
export const pendingTestImeFlushSettles = new Map<string, number>();

// Per-daemon-process cache of devices with the test IME active; input-actions.ts reads this to
// route text entry through the broadcast channel.
export const activeTestImeDevices = new Map<string, AndroidTestImeOwnership>();

const androidTestImeRecoveryLocks = new Map<string, Promise<unknown>>();

export function isAndroidTestImeActive(device: DeviceInfo): boolean {
  return activeTestImeDevices.has(getAndroidImeHelperDeviceKey(device));
}

export function getAndroidTestImeOwnership(
  device: DeviceInfo,
): AndroidTestImeOwnership | undefined {
  return activeTestImeDevices.get(getAndroidImeHelperDeviceKey(device));
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
  pendingTestImeFlushSettles.clear();
}

/**
 * @internal Test seam to force the active test-IME state for a device.
 */
export function setAndroidTestImeActiveForTests(
  device: DeviceInfo,
  active: boolean,
  stateDir = '/state',
): void {
  const key = getAndroidImeHelperDeviceKey(device);
  if (active) {
    activeTestImeDevices.set(key, { stateDir, rebindUnconfirmed: false });
  } else {
    activeTestImeDevices.delete(key);
  }
}
