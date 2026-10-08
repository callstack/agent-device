import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';
import { emitAndroidAdbDiagnostic, requireAndroidAdbHost } from './adb-host.ts';
import { resolveAndroidAdbExecutor } from './adb-provider-scope.ts';
import { runAdbShell } from './adb-executor.ts';
import type { AndroidAdbExecutor } from './adb-transport.ts';
import {
  ANDROID_IME_HELPER_SERVICE_COMPONENT,
  getAndroidImeHelperDeviceKey,
} from './ime-helper.ts';
import {
  clearPersistedPreviousIme,
  clearPersistedRebindDisplacement,
  readAndroidDefaultInputMethod,
  readAndroidTestImeDeviceRecord,
} from './ime-settings-record.ts';
import {
  activeTestImeDevices,
  pendingTestImeFlushSettles,
  withAndroidTestImeRecoveryLock,
} from './ime-state.ts';

// Restore and startup orphan recovery: undo the helper switch exactly when it is safe, keep
// durable evidence until the device is observed clean.

export type AndroidTestImeRestoreReason =
  | 'not-activated-here'
  | 'no-record'
  | 'record-unreadable'
  | 'helper-not-active'
  | 'owned-by-live-session'
  | 'set-failed'
  | 'ok';

export type AndroidTestImeRestoreResult = {
  restored: boolean;
  previousIme?: string;
  reason: AndroidTestImeRestoreReason;
};

// Android's SettingsProvider persists a setting change asynchronously: `ime set` answers from
// memory and the XML flush follows up to MAX_WRITE_SETTINGS_DELAY_MILLIS later (AOSP
// SettingsState.java, 2020ms cap). A device killed inside that window reboots from the stale
// file, so a restore followed by an immediate `adb emu kill` loses the keyboard on restart.
// The provider exposes no shell flush; holding the kill past the cap is the owning fix.
const SETTINGS_PROVIDER_FLUSH_SETTLE_MS = 2_500;

function flushSettleKey(stateDir: string, serial: string): string {
  return `${stateDir}:${serial}`;
}

// Wait out a window left open by a previous aborted close. `consumed` means this call retired a
// deadline a confirmed restore opened, which proves the device clean together with the covered
// window. `aborted` means this call was cancelled first, keeping both the deadline and the
// pending marker in place for the next close: an aborted settle is never a completed settle.
type FlushSettleOutcome = 'none' | 'consumed' | 'aborted';

async function awaitPendingFlushSettle(
  key: string,
  signal?: AbortSignal,
): Promise<FlushSettleOutcome> {
  const deadlineAtMs = pendingTestImeFlushSettles.get(key);
  if (deadlineAtMs === undefined) return 'none';
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    pendingTestImeFlushSettles.delete(key);
    return 'consumed';
  }
  await sleep(remainingMs, signal);
  if (signal?.aborted) return 'aborted';
  pendingTestImeFlushSettles.delete(key);
  return 'consumed';
}

// Run the flush settle for the restore just confirmed on this device. A cancelled close resolves
// the sleep early without reaching the deadline, so the deadline survives for the next close.
async function settleTestImeFlushWindow(key: string, signal?: AbortSignal): Promise<boolean> {
  const deadlineAtMs = Date.now() + SETTINGS_PROVIDER_FLUSH_SETTLE_MS;
  pendingTestImeFlushSettles.set(key, deadlineAtMs);
  await sleep(SETTINGS_PROVIDER_FLUSH_SETTLE_MS, signal);
  if (signal?.aborted) return false;
  pendingTestImeFlushSettles.delete(key);
  return true;
}

export async function restoreAndroidTestIme(
  device: DeviceInfo,
  options: { stateDir: string; shutdownTarget?: boolean; signal?: AbortSignal },
): Promise<AndroidTestImeRestoreResult> {
  return await withAndroidTestImeRecoveryLock(options.stateDir, device.id, async () => {
    const deviceKey = getAndroidImeHelperDeviceKey(device);
    const settleKey = flushSettleKey(options.stateDir, device.id);
    const killingTarget = options.shutdownTarget === true && device.kind === 'emulator';
    // This call returns before the close finalizer may start the kill, so a window opened by an
    // earlier aborted close is consumed here rather than outrunning this call's own restore.
    // An ordinary close starts no kill, so it neither consumes the window nor needs it covered;
    // the pending deadline stays for the next shutdown-bound close.
    const settleOutcome = killingTarget
      ? await awaitPendingFlushSettle(settleKey, options.signal)
      : 'none';
    let flushWindowCovered = settleOutcome !== 'aborted';
    let result: AndroidTestImeRestoreResult;
    if (!activeTestImeDevices.has(deviceKey)) {
      // Skip devices this process never activated (orphans from another process are handled by
      // restoreOrphanedAndroidTestImeOnDaemonStartup and the doctor check). Nothing was inspected,
      // so the device's recovery status stays unknown and its pending marker is none of ours —
      // unless this call just consumed a deadline opened by a confirmed restore.
      result = { restored: false, reason: 'not-activated-here' };
    } else {
      // Drop the owned-flag first so restoreAndroidTestImeFor's "owned by a live session" guard
      // does not skip this intentional close-time restore. The IME really is back on the previous
      // keyboard, so text routing must stop preferring the helper channel even on an abort.
      activeTestImeDevices.delete(deviceKey);
      const adb = resolveAndroidAdbExecutor(device);
      result = await restoreAndroidTestImeFor(adb, device);
      if (result.restored && killingTarget) {
        flushWindowCovered = await settleTestImeFlushWindow(settleKey, options.signal);
      }
    }
    const recoveryComplete =
      isDeviceRecoveryComplete(result.reason) ||
      (result.reason === 'not-activated-here' && settleOutcome === 'consumed');
    if (flushWindowCovered && recoveryComplete) {
      await requireAndroidAdbHost().imeRecoveryMarkers.clear(options.stateDir, device.id);
    }
    return result;
  });
}

// The device was inspected and the helper is confirmed off it (restored, already not the active
// IME, or no rebind record). A `set-failed` (still stuck), `record-unreadable` (the device may be
// on Android's fallback IME), `owned-by-live-session` (a live session will restore it on close)
// or `not-activated-here` (nothing was inspected) keeps its pending marker for a later retry.
function isDeviceRecoveryComplete(reason: AndroidTestImeRestoreReason): boolean {
  return reason === 'ok' || reason === 'helper-not-active' || reason === 'no-record';
}

// Undo the helper switch on one device. Invariants the review requires:
//  - Never restore a device a live session in this process owns (the fire-and-forget startup race).
//  - Only touch the IME when the helper is STILL the active input method, or the device record
//    marks an unconfirmed rebind. If the user (or a concurrent session) switched away, leave it.
//  - Only clear the persisted recovery value AFTER confirming the previous IME is actually
//    restored (read-back). A failed `ime set` keeps the value so recovery can retry.
async function restoreAndroidTestImeFor(
  adb: AndroidAdbExecutor,
  device: DeviceInfo,
): Promise<AndroidTestImeRestoreResult> {
  const deviceLabel = device.id;
  if (activeTestImeDevices.has(getAndroidImeHelperDeviceKey(device))) {
    // A live session in this process activated (or is activating) the helper here; leave it be.
    return { restored: false, reason: 'owned-by-live-session' };
  }
  const record = await readAndroidTestImeDeviceRecord(adb);
  if (record.kind === 'unreadable') {
    emitAndroidAdbDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_restore_record_unreadable',
      data: { device: deviceLabel },
    });
    return { restored: false, reason: 'record-unreadable' };
  }
  if (record.kind === 'absent') {
    return { restored: false, reason: 'no-record' };
  }
  const { previousIme } = record;
  const currentIme = await readAndroidDefaultInputMethod(adb);
  if (currentIme !== ANDROID_IME_HELPER_SERVICE_COMPONENT && !record.rebindDisplaced) {
    // Helper is not active — the user switched away, or the helper was never really set. Do not
    // overwrite the current IME, and do not clear the device record (a concurrent activation could
    // have just written it).
    emitAndroidAdbDiagnostic({
      level: 'debug',
      phase: 'android_test_ime_restore_skipped',
      data: { device: deviceLabel, currentIme, previousIme },
    });
    return { restored: false, previousIme, reason: 'helper-not-active' };
  }
  await runAdbShell(adb, ['ime', 'set', previousIme], { allowFailure: true, timeoutMs: 10_000 });
  const afterIme = await readAndroidDefaultInputMethod(adb);
  if (afterIme !== previousIme) {
    // Restore did not take effect. Keep the persisted value so recovery can retry — clearing it
    // now would permanently strand the user on the helper IME.
    emitAndroidAdbDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_restore_failed',
      data: { device: deviceLabel, previousIme, afterIme },
    });
    return { restored: false, previousIme, reason: 'set-failed' };
  }
  // Confirmed back on the previous IME — now it is safe to drop the recovery value.
  await clearPersistedPreviousIme(adb).catch(() => {});
  await clearPersistedRebindDisplacement(adb).catch(() => {});
  emitAndroidAdbDiagnostic({
    phase: 'android_test_ime_restored',
    data: { device: deviceLabel, previousIme },
  });
  return { restored: true, previousIme, reason: 'ok' };
}

// Best-effort: restore any test IME left active by a crashed daemon run. Gated on the device-scoped
// pending markers so it never spawns adb unless a prior run on this state dir actually switched a
// device — and it retains each device's marker until that device is observed clean, so an offline
// device that is still stuck is recovered on reconnect rather than being cleared prematurely.
export async function restoreOrphanedAndroidTestImeOnDaemonStartup(params: {
  stateDir: string;
  listSerials: () => Promise<string[]>;
}): Promise<void> {
  const markers = requireAndroidAdbHost().imeRecoveryMarkers;
  const pending = await markers.read(params.stateDir);
  if (pending.length === 0) {
    // No prior activation recorded for this state dir — nothing to recover, and no reason to spawn
    // adb (the macOS-CI regression this guard exists to prevent).
    return;
  }

  let connected: Set<string>;
  try {
    connected = new Set(await params.listSerials());
  } catch (error) {
    emitAndroidAdbDiagnostic({
      level: 'debug',
      phase: 'android_test_ime_startup_scan_failed',
      data: { error: normalizeError(error).message },
    });
    return;
  }

  for (const serial of pending) {
    if (!connected.has(serial)) {
      // Offline/disconnected: keep the marker and retry when the device reconnects.
      continue;
    }
    const device: DeviceInfo = {
      platform: 'android',
      id: serial,
      name: serial,
      kind: serial.startsWith('emulator-') ? 'emulator' : 'device',
      booted: true,
    };
    try {
      await withAndroidTestImeRecoveryLock(params.stateDir, serial, async () => {
        const adb = resolveAndroidAdbExecutor(device);
        const result = await restoreAndroidTestImeFor(adb, device);
        if (result.restored) {
          emitAndroidAdbDiagnostic({
            level: 'warn',
            phase: 'android_test_ime_orphan_restored',
            data: { device: serial, previousIme: result.previousIme },
          });
        }
        if (isDeviceRecoveryComplete(result.reason)) {
          await markers.clear(params.stateDir, serial);
        }
      });
    } catch (error) {
      // Keep the marker; a transient adb error must not drop a pending recovery.
      emitAndroidAdbDiagnostic({
        level: 'debug',
        phase: 'android_test_ime_orphan_restore_failed',
        data: { device: serial, error: normalizeError(error).message },
      });
    }
  }
}
