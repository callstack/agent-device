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
// The provider exposes no shell flush; holding the kill past the cap is the owning fix. The
// window runs from the oldest unwritten mutation and doWriteState() rewrites the whole file from
// the in-memory map, so windows coalesce into one deadline at max(existing, write + cap) rather
// than stacking; the margin past the cap only has to absorb the AtomicFile rename.
const SETTINGS_PROVIDER_FLUSH_SETTLE_MS = 2_500;

function flushSettleKey(stateDir: string, serial: string): string {
  return `${stateDir}:${serial}`;
}

// `idle`: nothing was open and this call opened none. `retired`: a deadline — this call's own
// restore write or one an earlier aborted close left behind — was waited out and cleared.
// `aborted`: the wait was cancelled, so the deadline and the pending marker both stay in place.
// An aborted settle is never a completed settle.
type FlushSettleOutcome = 'idle' | 'retired' | 'aborted';

async function settleFlushWindow(
  key: string,
  registeredAtMs: number | undefined,
  signal?: AbortSignal,
): Promise<FlushSettleOutcome> {
  let deadlineAtMs = pendingTestImeFlushSettles.get(key);
  if (registeredAtMs !== undefined) {
    deadlineAtMs = Math.max(deadlineAtMs ?? 0, registeredAtMs + SETTINGS_PROVIDER_FLUSH_SETTLE_MS);
    pendingTestImeFlushSettles.set(key, deadlineAtMs);
  }
  if (deadlineAtMs === undefined) return 'idle';
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs > 0) {
    await sleep(remainingMs, signal);
    if (signal?.aborted) return 'aborted';
  }
  pendingTestImeFlushSettles.delete(key);
  return 'retired';
}

// Whether this call proved the device needs no further recovery. A reason from an inspected
// device answers directly once the window it owed is covered; an aborted settle never covers it.
// A nothing-inspected `not-activated-here` close earns the clear only by retiring a deadline a
// confirmed restore opened — its own close opened none.
function isRecoveryMarkerClearEarned(
  reason: AndroidTestImeRestoreReason,
  outcome: FlushSettleOutcome,
): boolean {
  if (isDeviceRecoveryComplete(reason)) return outcome !== 'aborted';
  return reason === 'not-activated-here' && outcome === 'retired';
}

export async function restoreAndroidTestIme(
  device: DeviceInfo,
  options: { stateDir: string; shutdownTarget?: boolean; signal?: AbortSignal },
): Promise<AndroidTestImeRestoreResult> {
  return await withAndroidTestImeRecoveryLock(options.stateDir, device.id, async () => {
    const result = await restoreOwnedAndroidTestIme(device);
    // A kill-bound close returns only after every open window is covered — including one an
    // earlier aborted close left behind — so the finalizer's kill lands after the flush. The
    // restore's own write registers its window here, after the write, coalescing with the old
    // deadline instead of stacking behind it: one sleep to max(old, write + cap). An ordinary
    // close starts no kill, so it opens nothing and leaves any leftover deadline in place.
    const settling = options.shutdownTarget === true && device.kind === 'emulator';
    const outcome = settling
      ? await settleFlushWindow(
          flushSettleKey(options.stateDir, device.id),
          result.restored ? Date.now() : undefined,
          options.signal,
        )
      : 'idle';
    if (isRecoveryMarkerClearEarned(result.reason, outcome)) {
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
