import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { waitForStartupRecoveryFence } from '@agent-device/contracts/startup-recovery-fence';
import { emitAndroidAdbDiagnostic, requireAndroidAdbHost } from './adb-host.ts';
import { resolveAndroidAdbExecutor, resolveAndroidAdbProvider } from './adb-provider-scope.ts';
import {
  ensureAndroidImeHelper,
  getAndroidImeHelperDeviceKey,
  selectAndroidImeHelperArtifact,
} from './ime-helper.ts';
import {
  readAndroidDefaultInputMethod,
  readPersistedPreviousIme,
  restorePriorPersistedIme,
  writePersistedPreviousIme,
} from './ime-settings-record.ts';
import { activeTestImeDevices, withAndroidTestImeRecoveryLock } from './ime-state.ts';

// The activation transaction: acquire the helper, durably record the restore target, write the
// crash-recovery marker, and only then switch the IME — confirming each step by read-back.

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
  const markers = requireAndroidAdbHost().imeRecoveryMarkers;
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
    const markerPersisted = await markers.write(options.stateDir, device.id);
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
    emitAndroidAdbDiagnostic({
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
  const hadRecoveryMarker = (await markers.read(options.stateDir)).includes(device.id);
  if (!(await markers.write(options.stateDir, device.id))) {
    await restorePriorPersistedIme(adb, priorPersistedIme, device.id);
    emitAndroidAdbDiagnostic({
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
      await markers.clear(options.stateDir, device.id);
    }
    emitAndroidAdbDiagnostic({
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
  emitAndroidAdbDiagnostic({
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
