import { normalizeError } from '@agent-device/kernel/errors';
import { emitAndroidAdbDiagnostic } from './adb-host.ts';
import { runAdbShell } from './adb-executor.ts';
import type { AndroidAdbExecutor } from './adb-transport.ts';

// The on-device restore record. The previous-IME value lives in a custom `settings secure` key —
// not in a host-side file — so any daemon/state-dir can recover it.

const SETTINGS_KEY_PREVIOUS_IME = 'agent_device_ime_helper_previous_ime';
// While displaced, Android's fallback must not replace the user's restore target.
const SETTINGS_KEY_REBIND_DISPLACED = 'agent_device_ime_helper_rebind_displaced';
const SETTINGS_NAMESPACE = 'secure';
const DEFAULT_INPUT_METHOD_KEY = 'default_input_method';

export const ANDROID_TEST_IME_SETTINGS_KEYS = {
  previousIme: SETTINGS_KEY_PREVIOUS_IME,
  rebindDisplaced: SETTINGS_KEY_REBIND_DISPLACED,
  defaultInputMethod: DEFAULT_INPUT_METHOD_KEY,
};

export async function readAndroidDefaultInputMethod(adb: AndroidAdbExecutor): Promise<string> {
  const result = await runAdbShell(
    adb,
    ['settings', 'get', SETTINGS_NAMESPACE, DEFAULT_INPUT_METHOD_KEY],
    { allowFailure: true, timeoutMs: 5_000 },
  );
  return normalizeSettingsValue(result.exitCode === 0 ? result.stdout : '');
}

export async function readPersistedPreviousIme(
  adb: AndroidAdbExecutor,
): Promise<string | undefined> {
  return (await readSecureSetting(adb, SETTINGS_KEY_PREVIOUS_IME)) || undefined;
}

// Returns true only when the write succeeded AND reads back as the requested value — callers must
// not switch the IME unless the restore target is durably recorded.
export async function writePersistedPreviousIme(
  adb: AndroidAdbExecutor,
  value: string,
): Promise<boolean> {
  const result = await runAdbShell(
    adb,
    ['settings', 'put', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME, value],
    { allowFailure: true, timeoutMs: 5_000 },
  );
  if (result.exitCode !== 0) return false;
  return (await readPersistedPreviousIme(adb)) === value;
}

export async function clearPersistedPreviousIme(adb: AndroidAdbExecutor): Promise<void> {
  await runAdbShell(adb, ['settings', 'delete', SETTINGS_NAMESPACE, SETTINGS_KEY_PREVIOUS_IME], {
    allowFailure: true,
    timeoutMs: 5_000,
  });
}

export type AndroidTestImeDeviceRecord =
  | Readonly<{ kind: 'unreadable' }>
  | Readonly<{ kind: 'absent'; rebindDisplaced: boolean }>
  | Readonly<{ kind: 'owned'; previousIme: string; rebindDisplaced: boolean }>;

export async function readAndroidTestImeDeviceRecord(
  adb: AndroidAdbExecutor,
): Promise<AndroidTestImeDeviceRecord> {
  const previousIme = await readSecureSetting(adb, SETTINGS_KEY_PREVIOUS_IME);
  const displaced = await readSecureSetting(adb, SETTINGS_KEY_REBIND_DISPLACED);
  if (previousIme === undefined || displaced === undefined) return { kind: 'unreadable' };
  const rebindDisplaced = displaced === '1';
  return previousIme
    ? { kind: 'owned', previousIme, rebindDisplaced }
    : { kind: 'absent', rebindDisplaced };
}

export async function writePersistedRebindDisplacement(adb: AndroidAdbExecutor): Promise<boolean> {
  const result = await runAdbShell(
    adb,
    ['settings', 'put', SETTINGS_NAMESPACE, SETTINGS_KEY_REBIND_DISPLACED, '1'],
    { allowFailure: true, timeoutMs: 5_000 },
  );
  if (result.exitCode !== 0) return false;
  return (await readSecureSetting(adb, SETTINGS_KEY_REBIND_DISPLACED)) === '1';
}

export async function clearPersistedRebindDisplacement(adb: AndroidAdbExecutor): Promise<boolean> {
  await runAdbShell(
    adb,
    ['settings', 'delete', SETTINGS_NAMESPACE, SETTINGS_KEY_REBIND_DISPLACED],
    {
      allowFailure: true,
      timeoutMs: 5_000,
    },
  );
  return (await readSecureSetting(adb, SETTINGS_KEY_REBIND_DISPLACED)) === '';
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

/** The setting's value, `''` when unset, or `undefined` when it cannot be read. */
async function readSecureSetting(
  adb: AndroidAdbExecutor,
  key: string,
): Promise<string | undefined> {
  const result = await runAdbShell(adb, ['settings', 'get', SETTINGS_NAMESPACE, key], {
    allowFailure: true,
    timeoutMs: 5_000,
  });
  return result.exitCode === 0 ? normalizeSettingsValue(result.stdout) : undefined;
}

function normalizeSettingsValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null') return '';
  return trimmed;
}
