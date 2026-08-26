import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitAndroidAdbDiagnostic, requireAndroidAdbHost } from './adb-host.ts';
import { resolveAndroidAdbExecutor } from './adb-provider-scope.ts';
import type { AndroidAdbExecutor } from './adb-transport.ts';
import {
  ANDROID_IME_HELPER_SERVICE_COMPONENT,
  getAndroidImeHelperDeviceKey,
} from './ime-helper.ts';
import {
  clearPersistedPreviousIme,
  readAndroidDefaultInputMethod,
  readPersistedPreviousIme,
} from './ime-settings-record.ts';
import { activeTestImeDevices, withAndroidTestImeRecoveryLock } from './ime-state.ts';

// Restore and startup orphan recovery: undo the helper switch exactly when it is safe, keep
// durable evidence until the device is observed clean.

export type AndroidTestImeRestoreReason =
  | 'no-record'
  | 'helper-not-active'
  | 'owned-by-live-session'
  | 'set-failed'
  | 'ok';

export type AndroidTestImeRestoreResult = {
  restored: boolean;
  previousIme?: string;
  reason: AndroidTestImeRestoreReason;
};

export async function restoreAndroidTestIme(
  device: DeviceInfo,
  options: { stateDir: string },
): Promise<AndroidTestImeRestoreResult> {
  return await withAndroidTestImeRecoveryLock(options.stateDir, device.id, async () => {
    const deviceKey = getAndroidImeHelperDeviceKey(device);
    // Skip devices this process never activated (orphans from another process are handled by
    // restoreOrphanedAndroidTestImeOnDaemonStartup and the doctor check).
    if (!activeTestImeDevices.has(deviceKey)) {
      return { restored: false, reason: 'no-record' };
    }
    // Drop the owned-flag first so restoreAndroidTestImeFor's "owned by a live session" guard does
    // not skip this intentional close-time restore.
    activeTestImeDevices.delete(deviceKey);
    const adb = resolveAndroidAdbExecutor(device);
    const result = await restoreAndroidTestImeFor(adb, device);
    if (isDeviceRecoveryComplete(result.reason)) {
      await requireAndroidAdbHost().imeRecoveryMarkers.clear(options.stateDir, device.id);
    }
    return result;
  });
}

// A device no longer needs recovery once the helper is confirmed off it (restored, or already not
// the active IME, or no record). A `set-failed` (still stuck) or `owned-by-live-session` (a live
// session will restore it on close) keeps its pending marker for a later retry.
function isDeviceRecoveryComplete(reason: AndroidTestImeRestoreReason): boolean {
  return reason === 'ok' || reason === 'helper-not-active' || reason === 'no-record';
}

// Undo the helper switch on one device. Invariants the review requires:
//  - Never restore a device a live session in this process owns (the fire-and-forget startup race).
//  - Only touch the IME when the helper is STILL the active input method. If the user (or a
//    concurrent session) already switched away, leave their choice alone.
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
  const previousIme = await readPersistedPreviousIme(adb);
  if (!previousIme) {
    return { restored: false, reason: 'no-record' };
  }
  const currentIme = await readAndroidDefaultInputMethod(adb);
  if (currentIme !== ANDROID_IME_HELPER_SERVICE_COMPONENT) {
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
  await adb(['shell', 'ime', 'set', previousIme], { allowFailure: true, timeoutMs: 10_000 });
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
