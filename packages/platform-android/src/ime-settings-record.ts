import { normalizeError } from '@agent-device/kernel/errors';
import { emitAndroidAdbDiagnostic } from './adb-host.ts';
import type { AndroidAdbExecutor } from './adb-transport.ts';

// The on-device restore record. The previous-IME value lives in a custom `settings secure` key —
// not in a host-side file — so any daemon/state-dir can recover it.

const SETTINGS_KEY_PREVIOUS_IME = 'agent_device_ime_helper_previous_ime';
const SETTINGS_NAMESPACE = 'secure';
const DEFAULT_INPUT_METHOD_KEY = 'default_input_method';

export const ANDROID_TEST_IME_SETTINGS_KEYS = {
  previousIme: SETTINGS_KEY_PREVIOUS_IME,
  defaultInputMethod: DEFAULT_INPUT_METHOD_KEY,
};

export async function readAndroidDefaultInputMethod(adb: AndroidAdbExecutor): Promise<string> {
  const result = await adb(
    ['shell', 'settings', 'get', SETTINGS_NAMESPACE, DEFAULT_INPUT_METHOD_KEY],
    { allowFailure: true, timeoutMs: 5_000 },
  );
  return normalizeSettingsValue(result.exitCode === 0 ? result.stdout : '');
}

export async function readPersistedPreviousIme(
  adb: AndroidAdbExecutor,
): Promise<string | undefined> {
  const result = await adb(
    ['shell', 'settings', 'get', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME],
    { allowFailure: true, timeoutMs: 5_000 },
  );
  const value = normalizeSettingsValue(result.exitCode === 0 ? result.stdout : '');
  return value ? value : undefined;
}

// Returns true only when the write succeeded AND reads back as the requested value — callers must
// not switch the IME unless the restore target is durably recorded.
export async function writePersistedPreviousIme(
  adb: AndroidAdbExecutor,
  value: string,
): Promise<boolean> {
  const result = await adb(
    ['shell', 'settings', 'put', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME, value],
    { allowFailure: true, timeoutMs: 5_000 },
  );
  if (result.exitCode !== 0) return false;
  return (await readPersistedPreviousIme(adb)) === value;
}

export async function clearPersistedPreviousIme(adb: AndroidAdbExecutor): Promise<void> {
  await adb(['shell', 'settings', 'delete', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME], {
    allowFailure: true,
    timeoutMs: 5_000,
  });
}

/** Restores the device record changed by a failed pre-switch transaction; never touches markers. */
export async function restorePriorPersistedIme(
  adb: AndroidAdbExecutor,
  priorPersistedIme: string | undefined,
  deviceId: string,
): Promise<void> {
  try {
    const restored = priorPersistedIme
      ? await writePersistedPreviousIme(adb, priorPersistedIme)
      : await clearAndConfirmPersistedPreviousIme(adb);
    if (!restored) {
      emitAndroidAdbDiagnostic({
        level: 'warn',
        phase: 'android_test_ime_record_rollback_failed',
        data: { device: deviceId, hadPriorRecord: priorPersistedIme !== undefined },
      });
    }
  } catch (error) {
    emitAndroidAdbDiagnostic({
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
