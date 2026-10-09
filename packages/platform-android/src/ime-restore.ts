import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
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
  awaitTestImeFlushWindow,
  beginTestImeRestoreWrite,
  registerTestImeRestore,
  withAndroidTestImeRecoveryLock,
  type TestImeFlushWait,
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

// One marker-clear rule, owned here and used by both callers of the inner restore. A reason
// from an inspected device proves recovery complete once this call's flush wait is not
// abandoned: a kill-bound close must reach a covered outcome (an aborted wait is never a
// completed settle), while an ordinary close or the startup scan owe no wait at all — neither
// kills, and the device's window stays registered for the next kill-bound path to wait out. A
// nothing-inspected `not-activated-here` close earns the clear only on 'covered-confirmed':
// it saw no device, so the sole evidence that retrying is safe is that the covered window
// belonged to a write that confirmed. An issued-but-unconfirmed write leaves the helper
// possibly displaced and its persisted target intact, and the marker must survive for the
// startup scan to retry.
function isRecoveryMarkerClearEarned(
  reason: AndroidTestImeRestoreReason,
  settleOutcome: TestImeFlushWait,
): boolean {
  if (isDeviceRecoveryComplete(reason)) return settleOutcome !== 'aborted';
  return reason === 'not-activated-here' && settleOutcome === 'covered-confirmed';
}

export async function restoreAndroidTestIme(
  device: DeviceInfo,
  options: { stateDir: string; shutdownTarget?: boolean; signal?: AbortSignal },
): Promise<AndroidTestImeRestoreResult> {
  return await withAndroidTestImeRecoveryLock(options.stateDir, device.id, async () => {
    const result = await restoreOwnedAndroidTestIme(device);
    // Only a kill-bound close waits: it returns after the device's flush window is covered, so
    // the finalizer's kill lands after the provider's write. Ordinary closes never sleep.
    const settleOutcome: TestImeFlushWait =
      options.shutdownTarget === true
        ? await awaitTestImeFlushWindow(device.id, options.signal)
        : 'idle';
    if (isRecoveryMarkerClearEarned(result.reason, settleOutcome)) {
      await requireAndroidAdbHost().imeRecoveryMarkers.clear(options.stateDir, device.id);
    }
    return result;
  });
}

// Restore this process's own device, or report that it never activated one. For an unactivated
// device nothing is inspected (orphans from another process are handled by
// restoreOrphanedAndroidTestImeOnDaemonStartup and the doctor check), so recovery stays unknown.
async function restoreOwnedAndroidTestIme(
  device: DeviceInfo,
): Promise<AndroidTestImeRestoreResult> {
  const deviceKey = getAndroidImeHelperDeviceKey(device);
  if (!activeTestImeDevices.has(deviceKey)) {
    return { restored: false, reason: 'not-activated-here' };
  }
  // Drop the owned-flag first so restoreAndroidTestImeFor's "owned by a live session" guard does
  // not skip this intentional close-time restore. The IME really is back on the previous keyboard,
  // so text routing must stop preferring the helper channel even on an abort.
  activeTestImeDevices.delete(deviceKey);
  return await restoreAndroidTestImeFor(resolveAndroidAdbExecutor(device), device);
}

// The device was inspected and the helper is confirmed off it (restored, already not the active
// IME, or no rebind record). A `set-failed` (still stuck), `record-unreadable` (the device may be
// on Android's fallback IME), `owned-by-live-session` (a live session will restore it on close)
// or `not-activated-here` (nothing was inspected) keeps its pending marker for a later retry.
function isDeviceRecoveryComplete(reason: AndroidTestImeRestoreReason): boolean {
  return reason === 'ok' || reason === 'helper-not-active' || reason === 'no-record';
}

// Undo the helper switch on one device. Invariants:
//  - Never restore a device a live session in this process owns (the fire-and-forget startup race).
//  - Only touch the IME when the helper is STILL the active input method, or the device record
//    marks an unconfirmed rebind. If the user (or a concurrent session) switched away, leave it.
//  - Only clear the persisted recovery value AFTER confirming the previous IME is actually
//    restored (read-back). A failed `ime set` keeps the value so recovery can retry.
//  - Every issued emulator restore registers its flush window here, the only site that knows
//    the write was made, so no caller — close-time or startup-orphan — and no future call site
//    can restore without registering.
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
  // The provider's window opens when the device accepts this write, so the pending entry
  // opens before issuing it: a kill-bound waiter drains in-flight writes before consulting
  // marks and never reads the gap as "nothing owed". A `finally` close runs after the try
  // body's registration, so a waiter never sees the entry closed while its mark is absent.
  const pendingWriteOpens = beginTestImeRestoreWrite(device.id);
  let writeConfirmed = false;
  try {
    await runAdbShell(adb, ['ime', 'set', previousIme], {
      allowFailure: true,
      timeoutMs: 10_000,
    });
    const afterIme = await readAndroidDefaultInputMethod(adb);
    if (afterIme !== previousIme) {
      // Restore did not take effect. Keep the persisted value so recovery can retry — clearing
      // it now would permanently strand the user on the helper IME.
      emitAndroidAdbDiagnostic({
        level: 'warn',
        phase: 'android_test_ime_restore_failed',
        data: { device: deviceLabel, previousIme, afterIme },
      });
      return { restored: false, previousIme, reason: 'set-failed' };
    }
    // Confirmed back on the previous IME — the only outcome that earns clearing the persisted
    // record and the only mark provenance that may justify clearing another close's marker.
    // The flush hold attaches to the ISSUED write regardless (see the `finally`).
    writeConfirmed = true;
    // Now it is safe to drop the recovery value.
    await clearPersistedPreviousIme(adb).catch(() => {});
    await clearPersistedRebindDisplacement(adb).catch(() => {});
    emitAndroidAdbDiagnostic({
      phase: 'android_test_ime_restored',
      data: { device: deviceLabel, previousIme },
    });
    return { restored: true, previousIme, reason: 'ok' };
  } finally {
    // An issued emulator restore owes the kill-bound flush hold whatever the outcome: a
    // readback mismatch or post-dispatch throw cannot prove the provider never accepted the
    // write. Registering here, before the pending entry closes, keeps "a drained waiter never
    // sees closed-but-unregistered" a property of this one site; the mark carries whether
    // this write confirmed, which is the only fact that may retire retry evidence.
    if (device.kind === 'emulator') {
      registerTestImeRestore(device.id, writeConfirmed);
    }
    pendingWriteOpens();
  }
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
        // The inner restore has registered the device's flush window; startup never kills and
        // never waits, so its settle outcome is 'idle' — the same single clear rule the close
        // path applies, not a second notion of "done". The deadline stays in the map for the
        // next kill-bound path (close --shutdown or the shutdown runtime) to wait out.
        if (isRecoveryMarkerClearEarned(result.reason, 'idle')) {
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
