import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { runCmd } from '../../utils/exec.ts';
import { withKeyedLock } from '../../utils/keyed-lock.ts';
import { resolveAndroidAdbExecutor, resolveAndroidAdbProvider } from './adb-executor.ts';
import type { AndroidAdbExecutor } from './adb-executor.ts';
import {
  ANDROID_IME_HELPER_SERVICE_COMPONENT,
  ensureAndroidImeHelper,
  getAndroidImeHelperDeviceKey,
  selectAndroidImeHelperArtifact,
} from './ime-helper.ts';
import {
  clearAndroidTestImeRecoveryMarker,
  readAndroidTestImeRecoveryMarkers,
  writeAndroidTestImeRecoveryMarker,
} from './ime-recovery-marker.ts';
import { waitForStartupRecoveryFence } from '@agent-device/contracts/startup-recovery-fence';

// Previous-IME record lives on the device (a custom `settings secure` key), not in a host-side
// file, so any daemon/state-dir can recover it.
const SETTINGS_KEY_PREVIOUS_IME = 'agent_device_ime_helper_previous_ime';
const SETTINGS_NAMESPACE = 'secure';
const DEFAULT_INPUT_METHOD_KEY = 'default_input_method';

// Per-daemon-process cache of devices with the test IME active; input-actions.ts reads this to
// route text entry through the broadcast channel.
const activeTestImeDevices = new Set<string>();
const androidTestImeRecoveryLocks = new Map<string, Promise<unknown>>();

export function isAndroidTestImeActive(device: DeviceInfo): boolean {
  return activeTestImeDevices.has(getAndroidImeHelperDeviceKey(device));
}

export type AndroidTestImeActivationResult =
  | Readonly<{
      /**
       * The helper could not be obtained for this device: no bundled or provider artifact, or the
       * device refused the install. Nothing was mutated, so the caller falls back to ordinary text
       * entry. Every other failure — startup fence, recovery lock, or anything after the durable
       * records are touched — rejects instead of reporting an outcome.
       */
      outcome: 'helper-unavailable';
      reason: string;
    }>
  | Readonly<{
      outcome: 'settled';
      activated: boolean;
      alreadyActive: boolean;
      persistFailed?: boolean;
      previousIme?: string;
      helperServiceComponent: string;
      helperPackageName: string;
    }>;

export async function activateAndroidTestIme(
  device: DeviceInfo,
  options: { stateDir: string },
): Promise<AndroidTestImeActivationResult> {
  // Startup orphan recovery is intentionally fire-and-forget at daemon boot. Do not let an open
  // mutate the same durable records/device IME until that recovery has observed its marker set.
  await waitForStartupRecoveryFence(options.stateDir);
  return await withAndroidTestImeRecoveryLock(
    options.stateDir,
    device.id,
    async () => await activateAndroidTestImeAfterStartupRecovery(device, options),
  );
}

async function activateAndroidTestImeAfterStartupRecovery(
  device: DeviceInfo,
  options: { stateDir: string },
): Promise<AndroidTestImeActivationResult> {
  const adb = resolveAndroidAdbExecutor(device);
  const adbProvider = resolveAndroidAdbProvider(device);
  const deviceKey = getAndroidImeHelperDeviceKey(device);

  // The acquisition seam, and the only step whose failure is an outcome rather than a rejection.
  let artifact: Awaited<ReturnType<typeof selectAndroidImeHelperArtifact>>;
  try {
    artifact = await selectAndroidImeHelperArtifact(adbProvider);
    await ensureAndroidImeHelper({ adb, adbProvider, artifact, deviceKey });
  } catch (error) {
    return { outcome: 'helper-unavailable', reason: normalizeError(error).message };
  }
  const { manifest } = artifact;

  const currentIme = await readAndroidDefaultInputMethod(adb);
  if (currentIme === manifest.serviceComponent) {
    // Already active (idempotent call, or a previous crashed daemon left it active); keep the
    // existing persisted previous-IME record rather than overwriting it, but make sure this
    // process's crash is covered by a recovery marker.
    const markerPersisted = await writeAndroidTestImeRecoveryMarker(options.stateDir, device.id);
    const previousIme = await readPersistedPreviousIme(adb);
    if (markerPersisted) activeTestImeDevices.add(deviceKey);
    return {
      outcome: 'settled',
      activated: false,
      alreadyActive: true,
      ...(markerPersisted ? {} : { persistFailed: true }),
      previousIme,
      helperServiceComponent: manifest.serviceComponent,
      helperPackageName: manifest.packageName,
    };
  }

  // Durably record the restore target BEFORE the switch: confirm the settings write succeeded and
  // reads back. If it cannot be persisted, do NOT switch and report a failed activation to the
  // caller, so a rejected `settings put` can never strand the user on the helper with no restore
  // target.
  const priorPersistedIme = await readPersistedPreviousIme(adb);
  const persisted = await writePersistedPreviousIme(adb, currentIme);
  if (!persisted) {
    await restorePriorPersistedIme(adb, priorPersistedIme, device.id);
    emitDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_persist_failed',
      data: { device: device.id, previousIme: currentIme },
    });
    return {
      outcome: 'settled',
      activated: false,
      alreadyActive: false,
      persistFailed: true,
      helperServiceComponent: manifest.serviceComponent,
      helperPackageName: manifest.packageName,
    };
  }

  // Write the recovery marker BEFORE the switch. Ordering (durable record -> marker -> ime set)
  // guarantees the switch never happens without both a restore target and a startup trigger, and
  // closes the post-switch/pre-marker crash window entirely.
  const hadRecoveryMarker = (await readAndroidTestImeRecoveryMarkers(options.stateDir)).includes(
    device.id,
  );
  if (!(await writeAndroidTestImeRecoveryMarker(options.stateDir, device.id))) {
    await restorePriorPersistedIme(adb, priorPersistedIme, device.id);
    emitDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_marker_persist_failed',
      data: { device: device.id, previousIme: currentIme },
    });
    return {
      outcome: 'settled',
      activated: false,
      alreadyActive: false,
      persistFailed: true,
      helperServiceComponent: manifest.serviceComponent,
      helperPackageName: manifest.packageName,
    };
  }

  await adb(['shell', 'ime', 'enable', manifest.serviceComponent], {
    allowFailure: true,
    timeoutMs: 10_000,
  });
  const setResult = await adb(['shell', 'ime', 'set', manifest.serviceComponent], {
    allowFailure: true,
    timeoutMs: 10_000,
  });
  // Confirm the switch actually took effect by reading it back; do not trust the exit code alone.
  const activeIme = await readAndroidDefaultInputMethod(adb);
  if (activeIme !== manifest.serviceComponent) {
    // Switch never took effect, so the helper is not the active IME and the record/marker are
    // stale. Roll back only records this activation changed; a valid pre-existing marker remains
    // authoritative for its prior owner even when this attempted switch did not take effect.
    activeTestImeDevices.delete(deviceKey);
    await restorePriorPersistedIme(adb, priorPersistedIme, device.id);
    if (!hadRecoveryMarker) {
      await clearAndroidTestImeRecoveryMarker(options.stateDir, device.id);
    }
    emitDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_activate_failed',
      data: { device: device.id, activeIme, stderr: setResult.stderr.trim() },
    });
    return {
      outcome: 'settled',
      activated: false,
      alreadyActive: false,
      helperServiceComponent: manifest.serviceComponent,
      helperPackageName: manifest.packageName,
    };
  }

  // The recovery lock spans both durable records and the switch, so this process only claims
  // active ownership after the helper is confirmed active on the device.
  activeTestImeDevices.add(deviceKey);
  emitDiagnostic({
    phase: 'android_test_ime_activated',
    data: { device: device.id, previousIme: currentIme },
  });
  return {
    outcome: 'settled',
    activated: true,
    alreadyActive: false,
    previousIme: currentIme,
    helperServiceComponent: manifest.serviceComponent,
    helperPackageName: manifest.packageName,
  };
}

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
      await clearAndroidTestImeRecoveryMarker(options.stateDir, device.id);
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
    emitDiagnostic({
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
    emitDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_restore_failed',
      data: { device: deviceLabel, previousIme, afterIme },
    });
    return { restored: false, previousIme, reason: 'set-failed' };
  }
  // Confirmed back on the previous IME — now it is safe to drop the recovery value.
  await clearPersistedPreviousIme(adb).catch(() => {});
  emitDiagnostic({
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
  const pending = await readAndroidTestImeRecoveryMarkers(params.stateDir);
  if (pending.length === 0) {
    // No prior activation recorded for this state dir — nothing to recover, and no reason to spawn
    // adb (the macOS-CI regression this guard exists to prevent).
    return;
  }

  let connected: Set<string>;
  try {
    connected = new Set(await params.listSerials());
  } catch (error) {
    emitDiagnostic({
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
          emitDiagnostic({
            level: 'warn',
            phase: 'android_test_ime_orphan_restored',
            data: { device: serial, previousIme: result.previousIme },
          });
        }
        if (isDeviceRecoveryComplete(result.reason)) {
          await clearAndroidTestImeRecoveryMarker(params.stateDir, serial);
        }
      });
    } catch (error) {
      // Keep the marker; a transient adb error must not drop a pending recovery.
      emitDiagnostic({
        level: 'debug',
        phase: 'android_test_ime_orphan_restore_failed',
        data: { device: serial, error: normalizeError(error).message },
      });
    }
  }
}

function withAndroidTestImeRecoveryLock<T>(
  stateDir: string,
  serial: string,
  task: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(androidTestImeRecoveryLocks, `${stateDir}:${serial}`, task);
}

export async function readAndroidDefaultInputMethod(adb: AndroidAdbExecutor): Promise<string> {
  const result = await adb(
    ['shell', 'settings', 'get', SETTINGS_NAMESPACE, DEFAULT_INPUT_METHOD_KEY],
    { allowFailure: true, timeoutMs: 5_000 },
  );
  return normalizeSettingsValue(result.exitCode === 0 ? result.stdout : '');
}

async function readPersistedPreviousIme(adb: AndroidAdbExecutor): Promise<string | undefined> {
  const result = await adb(
    ['shell', 'settings', 'get', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME],
    { allowFailure: true, timeoutMs: 5_000 },
  );
  const value = normalizeSettingsValue(result.exitCode === 0 ? result.stdout : '');
  return value ? value : undefined;
}

// Returns true only when the write succeeded AND reads back as the requested value — callers must
// not switch the IME unless the restore target is durably recorded.
async function writePersistedPreviousIme(adb: AndroidAdbExecutor, value: string): Promise<boolean> {
  const result = await adb(
    ['shell', 'settings', 'put', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME, value],
    { allowFailure: true, timeoutMs: 5_000 },
  );
  if (result.exitCode !== 0) return false;
  return (await readPersistedPreviousIme(adb)) === value;
}

async function clearPersistedPreviousIme(adb: AndroidAdbExecutor): Promise<void> {
  await adb(['shell', 'settings', 'delete', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME], {
    allowFailure: true,
    timeoutMs: 5_000,
  });
}

/** Restores the device record changed by a failed pre-switch transaction; never touches markers. */
async function restorePriorPersistedIme(
  adb: AndroidAdbExecutor,
  priorPersistedIme: string | undefined,
  deviceId: string,
): Promise<void> {
  try {
    const restored = priorPersistedIme
      ? await writePersistedPreviousIme(adb, priorPersistedIme)
      : await clearAndConfirmPersistedPreviousIme(adb);
    if (!restored) {
      emitDiagnostic({
        level: 'warn',
        phase: 'android_test_ime_record_rollback_failed',
        data: { device: deviceId, hadPriorRecord: priorPersistedIme !== undefined },
      });
    }
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_record_rollback_failed',
      data: {
        device: deviceId,
        hadPriorRecord: priorPersistedIme !== undefined,
        error: normalizeError(error).message,
      },
    });
  }
}

async function clearAndConfirmPersistedPreviousIme(adb: AndroidAdbExecutor): Promise<boolean> {
  await clearPersistedPreviousIme(adb);
  return (await readPersistedPreviousIme(adb)) === undefined;
}

function normalizeSettingsValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null') return '';
  return trimmed;
}

// Serials only, with no full-inventory name, boot-state, or target probes.
export async function listAndroidAdbSerialsQuick(): Promise<string[]> {
  try {
    const result = await runCmd('adb', ['devices'], { timeoutMs: 5_000 });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('List of devices'))
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts[1] === 'device')
      .map((parts) => parts[0] as string);
  } catch {
    return [];
  }
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

export const ANDROID_TEST_IME_SETTINGS_KEYS = {
  previousIme: SETTINGS_KEY_PREVIOUS_IME,
  defaultInputMethod: DEFAULT_INPUT_METHOD_KEY,
};
