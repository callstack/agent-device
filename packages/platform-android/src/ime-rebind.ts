import type { DeviceInfo } from '@agent-device/kernel/device';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { emitAndroidAdbDiagnostic } from './adb-host.ts';
import {
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  runAdbShell,
} from './adb-provider-scope.ts';
import type { AndroidAdbExecutor } from './adb-transport.ts';
import { selectAndroidImeHelperArtifact } from './ime-helper.ts';
import {
  clearPersistedRebindDisplacement,
  readAndroidDefaultInputMethod,
  writePersistedRebindDisplacement,
} from './ime-settings-record.ts';
import { getAndroidTestImeOwnership, withAndroidTestImeRecoveryLock } from './ime-state.ts';

export type AndroidTestImeRebindOutcome =
  | Readonly<{ kind: 'confirmed' }>
  | Readonly<{ kind: 'not-owned' }>
  | Readonly<{
      kind: 'unconfirmed';
      cause: 'record-write' | 'command-failed' | 'helper-not-selected' | 'read-failed';
    }>;

export async function rebindAndroidTestIme(
  device: DeviceInfo,
): Promise<AndroidTestImeRebindOutcome> {
  const ownership = getAndroidTestImeOwnership(device);
  if (!ownership) return { kind: 'not-owned' };
  return await withAndroidTestImeRecoveryLock(ownership.stateDir, device.id, async () => {
    if (getAndroidTestImeOwnership(device) !== ownership) return { kind: 'not-owned' };
    const adb = resolveAndroidAdbExecutor(device);
    const { manifest } = await selectAndroidImeHelperArtifact(resolveAndroidAdbProvider(device));
    emitAndroidAdbDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_rebind',
      data: { device: device.id },
    });
    ownership.rebindUnconfirmed = true;
    let cause: Extract<AndroidTestImeRebindOutcome, { kind: 'unconfirmed' }>['cause'] =
      'record-write';
    try {
      if (!(await writePersistedRebindDisplacement(adb))) return unconfirmed(device.id, cause);
      cause = 'command-failed';
      for (const verb of ['disable', 'enable', 'set'] as const) {
        const result = await runAdbShell(adb, ['ime', verb, manifest.serviceComponent], {
          allowFailure: true,
          timeoutMs: 10_000,
        });
        if (result.exitCode !== 0) return unconfirmed(device.id, cause);
      }
      cause = 'read-failed';
      const activeIme = await readAndroidDefaultInputMethod(adb);
      if (activeIme !== manifest.serviceComponent) {
        return unconfirmed(device.id, activeIme ? 'helper-not-selected' : 'read-failed');
      }
      // Failed cleanup keeps admission on the rebind path even with the helper selected.
      ownership.rebindUnconfirmed = !(await clearRebindRecord(adb, device.id));
      return { kind: 'confirmed' };
    } catch (error) {
      if (isRequestCanceledError(error)) throw error;
    }
    return unconfirmed(device.id, cause);
  });
}

function unconfirmed(
  deviceId: string,
  cause: Extract<AndroidTestImeRebindOutcome, { kind: 'unconfirmed' }>['cause'],
): AndroidTestImeRebindOutcome {
  emitAndroidAdbDiagnostic({
    level: 'warn',
    phase: 'android_test_ime_rebind_failed',
    data: { device: deviceId, cause },
  });
  return { kind: 'unconfirmed', cause };
}

async function clearRebindRecord(adb: AndroidAdbExecutor, deviceId: string): Promise<boolean> {
  const cleared = await clearPersistedRebindDisplacement(adb);
  if (!cleared)
    emitAndroidAdbDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_rebind_record_clear_failed',
      data: { device: deviceId },
    });
  return cleared;
}
