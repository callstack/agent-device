import type { DeviceInfo } from '../../kernel/device.ts';
import { normalizeError } from '../../kernel/errors.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { runCmd } from '../../utils/exec.ts';
import { resolveAndroidAdbExecutor, resolveAndroidAdbProvider } from './adb-executor.ts';
import type { AndroidAdbExecutor } from './adb-executor.ts';
import {
  ensureAndroidImeHelper,
  getAndroidImeHelperDeviceKey,
  resolveAndroidImeHelperArtifact,
} from './ime-helper.ts';

// Previous-IME record lives on the device (a custom `settings secure` key), not in a host-side
// file, so any daemon/state-dir can recover it.
const SETTINGS_KEY_PREVIOUS_IME = 'agent_device_ime_helper_previous_ime';
const SETTINGS_NAMESPACE = 'secure';
const DEFAULT_INPUT_METHOD_KEY = 'default_input_method';

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

  // Persist before switching, so a mid-crash still leaves a recoverable record.
  await writePersistedPreviousIme(adb, currentIme);
  await adb(['shell', 'ime', 'enable', manifest.serviceComponent], {
    allowFailure: true,
    timeoutMs: 10_000,
  });
  const setResult = await adb(['shell', 'ime', 'set', manifest.serviceComponent], {
    allowFailure: true,
    timeoutMs: 10_000,
  });
  if (setResult.exitCode !== 0) {
    // Switch never took effect; roll back the persisted record.
    await clearPersistedPreviousIme(adb).catch(() => {});
    emitDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_activate_failed',
      data: { device: device.id, stderr: setResult.stderr.trim() },
    });
    return {
      activated: false,
      alreadyActive: false,
      helperServiceComponent: manifest.serviceComponent,
      helperPackageName: manifest.packageName,
    };
  }

  activeTestImeDevices.add(getAndroidImeHelperDeviceKey(device));
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
};

export async function restoreAndroidTestIme(
  device: DeviceInfo,
): Promise<AndroidTestImeRestoreResult> {
  const deviceKey = getAndroidImeHelperDeviceKey(device);
  // Skip devices this process never activated (orphans from another process are handled by
  // restoreOrphanedAndroidTestImeOnDaemonStartup and the doctor check).
  if (!activeTestImeDevices.has(deviceKey)) {
    return { restored: false };
  }
  activeTestImeDevices.delete(deviceKey);
  const adb = resolveAndroidAdbExecutor(device);
  return await restoreAndroidTestImeFor(adb, device.id);
}

async function restoreAndroidTestImeFor(
  adb: AndroidAdbExecutor,
  deviceLabel: string,
): Promise<AndroidTestImeRestoreResult> {
  const previousIme = await readPersistedPreviousIme(adb);
  if (!previousIme) {
    return { restored: false };
  }
  try {
    await adb(['shell', 'ime', 'set', previousIme], { allowFailure: true, timeoutMs: 10_000 });
  } finally {
    // Clear even on failure; the doctor check is the safety net for genuinely stuck state.
    await clearPersistedPreviousIme(adb).catch(() => {});
  }
  emitDiagnostic({
    phase: 'android_test_ime_restored',
    data: { device: deviceLabel, previousIme },
  });
  return { restored: true, previousIme };
}

// Best-effort: restore any test IME left active by a crashed daemon run.
export async function restoreOrphanedAndroidTestImeOnDaemonStartup(params: {
  listSerials: () => Promise<string[]>;
}): Promise<void> {
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
      const result = await restoreAndroidTestImeFor(adb, serial);
      if (result.restored) {
        emitDiagnostic({
          level: 'warn',
          phase: 'android_test_ime_orphan_restored',
          data: { device: serial, previousIme: result.previousIme },
        });
      }
    } catch (error) {
      emitDiagnostic({
        level: 'debug',
        phase: 'android_test_ime_orphan_restore_failed',
        data: { device: serial, error: normalizeError(error).message },
      });
    }
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
