import type { DeviceInfo } from '@agent-device/kernel/device';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { sleep } from '@agent-device/host-kit/retry';
import { getAndroidImeHelperDeviceKey } from './ime-helper.ts';

// Process-lived test-IME ownership state, shared by activation, restore, startup recovery, and
// the emulator kill path.

export type AndroidTestImeOwnership = {
  /** The recovery scope whose lock and marker guard this device's IME. */
  readonly stateDir: string;
  /** A rebind left the helper unconfirmed; text must not reach it before a confirmed rebind. */
  rebindUnconfirmed: boolean;
};

// Android's SettingsProvider persists a setting change asynchronously: `ime set` answers from
// memory and the XML flush follows up to MAX_WRITE_SETTINGS_DELAY_MILLIS later (AOSP
// SettingsState.java, 2020ms cap). A device killed inside that window reboots from the stale
// file, so a restore followed by an immediate `adb emu kill` loses the keyboard on restart.
// The provider exposes no shell flush; holding the kill past the cap is the owning fix. The
// margin past the cap only has to absorb the AtomicFile rename.
const SETTINGS_PROVIDER_FLUSH_SETTLE_MS = 2_500;

// Per-device last-restore marks, keyed by serial, timed entirely on the PROCESS MONOTONIC
// CLOCK (performance.now) — never the wall clock, as the name suffix encodes. sleep() is
// timed on libuv's monotonic loop clock, so a wall-clock-derived remaining time would mix two
// clocks by construction (the skew stable-capture.ts documents in prose), and a forward step
// from NTP or VM resume could make remainingMs negative and release the kill inside the
// window. One source for both registration and expiry means neither can drift against the
// other. The flush window is a property of the device's SettingsProvider, not of any host
// state dir or of the close that performed the restore. Every restore only moves the mark
// forward, so it can never consume evidence a later kill needs — the wait is always derived
// from the newest write, which is also why windows coalesce into one wait rather than
// stacking. Every path that may `adb emu kill` calls awaitTestImeFlushWindow first; the
// kill-bound close finalization also consumes the outcome so the pending marker clears only
// under a completed (or never-owed) wait.
// @internal the map is exported for tests; production touches it only through the helpers here.
export const testImeLastRestoreAtPerfMs = new Map<string, number>();

export type TestImeFlushWait = 'idle' | 'covered' | 'aborted';

// The write that earned the window calls this, on every confirmed emulator restore — close-time,
// cross-session, or startup-orphan recovery.
export function registerTestImeRestore(serial: string): void {
  testImeLastRestoreAtPerfMs.set(
    serial,
    Math.max(testImeLastRestoreAtPerfMs.get(serial) ?? 0, performance.now()),
  );
}

// Wait until the device's newest restore write is older than the flush window. Returns 'idle'
// when this process never restored the device (no evidence to wait for), 'covered' once the
// window has elapsed — retiring the timestamp, since nothing older can still be unflushed — and
// 'aborted' when cancelled first: the caller must then skip the kill, and the timestamp stays so
// the next kill-bound path derives the same remaining wait.
// This re-reads the mark after every sleep rather than trusting one read: a restore can land
// while this wait sleeps (the unlocked shutdown-command path racing a close finalization, or
// startup-orphan recovery beside another session's close), and it is THIS caller that owns the
// kill, so it must wait out the newer deadline — reporting 'covered' on an older mark would
// release the kill inside the extension's window, which is #3318 again. Each iteration consumes
// only the mark it observed: with no await between the read and the delete, the delete cannot
// erase a mark this loop has not waited for, so an extension always survives to its own round.
export async function awaitTestImeFlushWindow(
  serial: string,
  signal?: AbortSignal,
): Promise<TestImeFlushWait> {
  if (signal?.aborted) return 'aborted';
  for (;;) {
    const restoredAtPerfMs = testImeLastRestoreAtPerfMs.get(serial);
    if (restoredAtPerfMs === undefined) return 'idle';
    const remainingMs = restoredAtPerfMs + SETTINGS_PROVIDER_FLUSH_SETTLE_MS - performance.now();
    if (remainingMs <= 0) {
      testImeLastRestoreAtPerfMs.delete(serial);
      return 'covered';
    }
    await sleep(remainingMs, signal);
    if (signal?.aborted) return 'aborted';
    // A real sleep that returned un-aborted has elapsed THIS round's window, so consume only
    // the mark this round waited for: unchanged or retired means covered, while a newer mark
    // (registered while this sleep ran) loops to wait out the extension's deadline too.
    const currentPerfMs = testImeLastRestoreAtPerfMs.get(serial);
    if (currentPerfMs === undefined) return 'covered';
    if (currentPerfMs === restoredAtPerfMs) {
      testImeLastRestoreAtPerfMs.delete(serial);
      return 'covered';
    }
  }
}

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
 * @internal Test isolation hook for the active test-IME device set and flush timestamps.
 */
export function resetAndroidTestImeActivationCacheForTests(): void {
  activeTestImeDevices.clear();
  testImeLastRestoreAtPerfMs.clear();
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
