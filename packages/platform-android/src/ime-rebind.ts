import type { DeviceInfo } from '@agent-device/kernel/device';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { emitAndroidAdbDiagnostic } from './adb-host.ts';
import { resolveAndroidAdbExecutor } from './adb-provider-scope.ts';
import type { AndroidAdbExecutor } from './adb-transport.ts';
import { ANDROID_IME_HELPER_SERVICE_COMPONENT, rebindAndroidImeHelper } from './ime-helper.ts';
import {
  clearPersistedRebindDisplacement,
  readAndroidDefaultInputMethod,
  writePersistedRebindDisplacement,
} from './ime-settings-record.ts';
import { getAndroidTestImeOwnership, withAndroidTestImeRecoveryLock } from './ime-state.ts';

// The rebind transaction, beside activation and restore: recreate the owned test IME so the focused
// field starts a fresh input session with it.

export type AndroidTestImeRebindOutcome =
  | Readonly<{ kind: 'confirmed' }>
  | Readonly<{ kind: 'not-owned' }>
  | Readonly<{
      kind: 'unconfirmed';
      /**
       * `record-write`: the device record could not mark the rebind, so the helper was left alone.
       * `helper-not-selected`: another IME reads back as selected. `read-failed`: the rebind or its
       * read-back failed, so the selected IME is unknown.
       */
      cause: 'record-write' | 'helper-not-selected' | 'read-failed';
    }>;

/**
 * Rebinds the owned test IME and reads back whether the helper is the selected IME. Serialized with
 * activation and restore under the owner's recovery lock. The device record marks the rebind before
 * the helper is disabled and is cleared only on confirmation, so restore — at close or after a
 * crash — returns an unconfirmed device to the user's IME even when Android fell back to another one.
 */
export async function rebindAndroidTestIme(
  device: DeviceInfo,
): Promise<AndroidTestImeRebindOutcome> {
  const ownership = getAndroidTestImeOwnership(device);
  if (!ownership) return { kind: 'not-owned' };
  return await withAndroidTestImeRecoveryLock(ownership.stateDir, device.id, async () => {
    if (getAndroidTestImeOwnership(device) !== ownership) return { kind: 'not-owned' };
    const adb = resolveAndroidAdbExecutor(device);
    emitAndroidAdbDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_rebind',
      data: { device: device.id },
    });
    // Set first so a canceled rebind, which rejects, still leaves the next entry on the rebind path.
    ownership.rebindUnconfirmed = true;
    const outcome = await rebindAndConfirm(adb, device.id);
    // A confirmed helper whose record could not be cleared still needs the next entry to rebind.
    ownership.rebindUnconfirmed =
      outcome.kind !== 'confirmed' || !(await clearRebindRecord(adb, device.id));
    return outcome;
  });
}

async function rebindAndConfirm(
  adb: AndroidAdbExecutor,
  deviceId: string,
): Promise<AndroidTestImeRebindOutcome> {
  if (!(await writePersistedRebindDisplacement(adb))) {
    emitAndroidAdbDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_rebind_record_failed',
      data: { device: deviceId },
    });
    return { kind: 'unconfirmed', cause: 'record-write' };
  }
  const activeIme = await rebindAndReadSelectedIme(adb);
  if (activeIme === ANDROID_IME_HELPER_SERVICE_COMPONENT) return { kind: 'confirmed' };
  const cause = activeIme ? 'helper-not-selected' : 'read-failed';
  emitAndroidAdbDiagnostic({
    level: 'warn',
    phase: 'android_test_ime_rebind_failed',
    data: { device: deviceId, activeIme, cause },
  });
  return { kind: 'unconfirmed', cause };
}

async function clearRebindRecord(adb: AndroidAdbExecutor, deviceId: string): Promise<boolean> {
  if (await clearPersistedRebindDisplacement(adb)) return true;
  emitAndroidAdbDiagnostic({
    level: 'warn',
    phase: 'android_test_ime_rebind_record_clear_failed',
    data: { device: deviceId },
  });
  return false;
}

/**
 * The IME selected after the rebind, or `undefined` when the rebind or its read-back failed. A
 * canceled request rejects instead; the device record stays set for restore either way.
 */
async function rebindAndReadSelectedIme(adb: AndroidAdbExecutor): Promise<string | undefined> {
  try {
    await rebindAndroidImeHelper(adb);
    return (await readAndroidDefaultInputMethod(adb)) || undefined;
  } catch (error) {
    if (isRequestCanceledError(error)) throw error;
    return undefined;
  }
}
