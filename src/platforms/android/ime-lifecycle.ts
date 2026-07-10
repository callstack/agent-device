import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeviceInfo } from '../../kernel/device.ts';
import { normalizeError } from '../../kernel/errors.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { runCmd } from '../../utils/exec.ts';
import { resolveAndroidAdbExecutor, resolveAndroidAdbProvider } from './adb-executor.ts';
import type { AndroidAdbExecutor } from './adb-executor.ts';
import {
  ANDROID_IME_HELPER_SERVICE_COMPONENT,
  ensureAndroidImeHelper,
  getAndroidImeHelperDeviceKey,
  resolveAndroidImeHelperArtifact,
} from './ime-helper.ts';

// Previous-IME record lives on the device (a custom `settings secure` key), not in a host-side
// file, so any daemon/state-dir can recover it.
const SETTINGS_KEY_PREVIOUS_IME = 'agent_device_ime_helper_previous_ime';
const SETTINGS_NAMESPACE = 'secure';
const DEFAULT_INPUT_METHOD_KEY = 'default_input_method';

// Host-side marker written in the daemon state dir when a session activates the test IME. The
// daemon-startup orphan scan is gated on it, so a host that never uses the Android test IME (e.g.
// the macOS CI runner, which nonetheless ships adb) never spawns `adb devices` at startup.
const STARTUP_RECOVERY_MARKER = 'android-test-ime-active.marker';

function startupRecoveryMarkerPath(stateDir: string): string {
  return path.join(stateDir, STARTUP_RECOVERY_MARKER);
}

export async function markAndroidTestImeStartupRecovery(stateDir: string): Promise<void> {
  try {
    await fs.writeFile(startupRecoveryMarkerPath(stateDir), '');
  } catch (error) {
    emitDiagnostic({
      level: 'debug',
      phase: 'android_test_ime_marker_write_failed',
      data: { stateDir, error: normalizeError(error).message },
    });
  }
}

// Per-daemon-process cache of devices with the test IME active; input-actions.ts reads this to
// route text entry through the broadcast channel.
const activeTestImeDevices = new Set<string>();

export function isAndroidTestImeActive(device: DeviceInfo): boolean {
  return activeTestImeDevices.has(getAndroidImeHelperDeviceKey(device));
}

export type AndroidTestImeActivationResult = {
  activated: boolean;
  alreadyActive: boolean;
  previousIme?: string;
  helperServiceComponent: string;
  helperPackageName: string;
};

export async function activateAndroidTestIme(
  device: DeviceInfo,
): Promise<AndroidTestImeActivationResult> {
  const adb = resolveAndroidAdbExecutor(device);
  const adbProvider = resolveAndroidAdbProvider(device);
  const artifact = await resolveAndroidImeHelperArtifact();
  const { manifest } = artifact;

  await ensureAndroidImeHelper({
    adb,
    adbProvider,
    artifact,
    deviceKey: getAndroidImeHelperDeviceKey(device),
  });

  const currentIme = await readAndroidDefaultInputMethod(adb);
  if (currentIme === manifest.serviceComponent) {
    // Already active (idempotent call, or a previous crashed daemon left it active); keep the
    // existing persisted previous-IME record rather than overwriting it.
    activeTestImeDevices.add(getAndroidImeHelperDeviceKey(device));
    const previousIme = await readPersistedPreviousIme(adb);
    return {
      activated: false,
      alreadyActive: true,
      previousIme,
      helperServiceComponent: manifest.serviceComponent,
      helperPackageName: manifest.packageName,
    };
  }

  // Mark active BEFORE switching. Startup orphan-recovery runs fire-and-forget and only touches a
  // device once it reads currentIme === helper; because we add to the set strictly before the
  // `ime set`, any recovery pass that could observe the helper active also observes this flag and
  // skips the device, so it can never restore out from under a session we are opening.
  const deviceKey = getAndroidImeHelperDeviceKey(device);
  activeTestImeDevices.add(deviceKey);

  // Persist before switching, so a mid-crash still leaves a recoverable record. Never persist the
  // helper itself as the previous IME (the `alreadyActive` branch above returns before this),
  // which keeps the recovery value trustworthy under concurrent activation.
  await writePersistedPreviousIme(adb, currentIme);
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
    // Switch never took effect, so the helper is not the active IME and the recovery value is
    // stale. Safe to clear here: this is the activating process, holding the device, so no
    // concurrent session can have just written a value we would be dropping.
    activeTestImeDevices.delete(deviceKey);
    await clearPersistedPreviousIme(adb).catch(() => {});
    emitDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_activate_failed',
      data: { device: device.id, activeIme, stderr: setResult.stderr.trim() },
    });
    return {
      activated: false,
      alreadyActive: false,
      helperServiceComponent: manifest.serviceComponent,
      helperPackageName: manifest.packageName,
    };
  }

  emitDiagnostic({
    phase: 'android_test_ime_activated',
    data: { device: device.id, previousIme: currentIme },
  });
  return {
    activated: true,
    alreadyActive: false,
    previousIme: currentIme,
    helperServiceComponent: manifest.serviceComponent,
    helperPackageName: manifest.packageName,
  };
}

export type AndroidTestImeRestoreResult = {
  restored: boolean;
  previousIme?: string;
  reason?: 'no-record' | 'helper-not-active' | 'set-failed' | 'ok';
};

export async function restoreAndroidTestIme(
  device: DeviceInfo,
): Promise<AndroidTestImeRestoreResult> {
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
  return await restoreAndroidTestImeFor(adb, device);
}

// Undo the helper switch on one device. Invariants the maintainer's review requires:
//  - Never restore a device a live session in this process owns (the fire-and-forget startup race).
//  - Only touch the IME when the helper is STILL the active input method. If the user (or a
//    concurrent session) already switched away, leave their choice alone.
//  - Only clear the persisted recovery value AFTER confirming the previous IME is actually
//    restored (read-back). A failed `ime set` must keep the value so a later retry / startup
//    recovery / doctor remediation can still recover from it — never strand the user on the helper.
async function restoreAndroidTestImeFor(
  adb: AndroidAdbExecutor,
  device: DeviceInfo,
): Promise<AndroidTestImeRestoreResult> {
  const deviceLabel = device.id;
  if (activeTestImeDevices.has(getAndroidImeHelperDeviceKey(device))) {
    // A live session in this process activated (or is activating) the helper here; leave it be.
    return { restored: false, reason: 'helper-not-active' };
  }
  const previousIme = await readPersistedPreviousIme(adb);
  if (!previousIme) {
    return { restored: false, reason: 'no-record' };
  }
  const currentIme = await readAndroidDefaultInputMethod(adb);
  if (currentIme !== ANDROID_IME_HELPER_SERVICE_COMPONENT) {
    // Helper is not active — the user switched away, another process already restored, or the
    // helper was never really set. Do not overwrite the current IME, and do not clear the record
    // (clearing here could drop a value a concurrent activation just wrote).
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

// Best-effort: restore any test IME left active by a crashed daemon run. Gated on the host-side
// marker so it never spawns adb unless a prior run on this state dir actually activated the test
// IME — this keeps the fire-and-forget startup path off adb on hosts that don't use it.
export async function restoreOrphanedAndroidTestImeOnDaemonStartup(params: {
  stateDir: string;
  listSerials: () => Promise<string[]>;
}): Promise<void> {
  const markerPath = startupRecoveryMarkerPath(params.stateDir);
  try {
    await fs.access(markerPath);
  } catch {
    // No prior activation recorded for this state dir — nothing to recover, and importantly no
    // reason to spawn adb (the macOS-CI regression this guard exists to prevent).
    return;
  }

  let serials: string[];
  try {
    serials = await params.listSerials();
  } catch (error) {
    emitDiagnostic({
      level: 'debug',
      phase: 'android_test_ime_startup_scan_failed',
      data: { error: normalizeError(error).message },
    });
    return;
  }
  let anyStillStuck = false;
  for (const serial of serials) {
    const device: DeviceInfo = {
      platform: 'android',
      id: serial,
      name: serial,
      kind: serial.startsWith('emulator-') ? 'emulator' : 'device',
      booted: true,
    };
    try {
      const adb = resolveAndroidAdbExecutor(device);
      const result = await restoreAndroidTestImeFor(adb, device);
      if (result.restored) {
        emitDiagnostic({
          level: 'warn',
          phase: 'android_test_ime_orphan_restored',
          data: { device: serial, previousIme: result.previousIme },
        });
      } else if (result.reason === 'set-failed') {
        anyStillStuck = true;
      }
    } catch (error) {
      anyStillStuck = true;
      emitDiagnostic({
        level: 'debug',
        phase: 'android_test_ime_orphan_restore_failed',
        data: { device: serial, error: normalizeError(error).message },
      });
    }
  }
  // Clear the marker once nothing is left stuck, so the next startup does not re-scan (and does
  // not spawn adb) for an already-clean host. Keep it if a restore failed, so recovery retries.
  if (!anyStillStuck) {
    await fs.rm(markerPath, { force: true }).catch(() => {});
  }
}

export async function readAndroidDefaultInputMethod(adb: AndroidAdbExecutor): Promise<string> {
  const result = await adb(
    ['shell', 'settings', 'get', SETTINGS_NAMESPACE, DEFAULT_INPUT_METHOD_KEY],
    {
      allowFailure: true,
      timeoutMs: 5_000,
    },
  );
  return normalizeSettingsValue(result.exitCode === 0 ? result.stdout : '');
}

async function readPersistedPreviousIme(adb: AndroidAdbExecutor): Promise<string | undefined> {
  const result = await adb(
    ['shell', 'settings', 'get', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME],
    {
      allowFailure: true,
      timeoutMs: 5_000,
    },
  );
  const value = normalizeSettingsValue(result.exitCode === 0 ? result.stdout : '');
  return value ? value : undefined;
}

async function writePersistedPreviousIme(adb: AndroidAdbExecutor, value: string): Promise<void> {
  await adb(['shell', 'settings', 'put', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME, value], {
    allowFailure: true,
    timeoutMs: 5_000,
  });
}

async function clearPersistedPreviousIme(adb: AndroidAdbExecutor): Promise<void> {
  await adb(['shell', 'settings', 'delete', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME], {
    allowFailure: true,
    timeoutMs: 5_000,
  });
}

function normalizeSettingsValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null') return '';
  return trimmed;
}

// Serials only, no per-device name/booted/target lookups (unlike listAndroidDevices()).
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

export function resetAndroidTestImeActivationCacheForTests(): void {
  activeTestImeDevices.clear();
}

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
