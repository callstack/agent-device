import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  resolveAndroidAdbProvider,
  type AndroidAdbExecutor,
  type AndroidAdbProvider,
} from './adb-executor.ts';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { resolveAndroidHelperArtifact } from './helper-package-install.ts';
import { parseAndroidSnapshotHelperManifest } from './snapshot-helper-artifact.ts';
import { ensureAndroidSnapshotHelper } from './snapshot-helper-install.ts';
import { stopAndroidSnapshotHelperSession } from './snapshot-helper-session-lifecycle.ts';
import {
  getAndroidSnapshotHelperSessionDeviceKey,
  recoverAndroidSnapshotHelperRetirement,
} from './snapshot-helper-retirement.ts';
import type {
  AndroidSnapshotHelperArtifact,
  AndroidSnapshotHelperInstallResult,
} from './snapshot-helper-types.ts';
const HELPER_INSTALL_TIMEOUT_MS = 30_000;
type PreparedAndroidAutomationHelper = {
  adb: AndroidAdbExecutor;
  adbProvider: AndroidAdbProvider;
  artifact: AndroidSnapshotHelperArtifact;
  install: AndroidSnapshotHelperInstallResult;
  deviceKey: string;
};

// Sessions are keyed by device, so reuse must also prove the live session runs the helper binary
// this command selected; a mismatch stops the session and the command falls back to one-shot.
export function androidAutomationHelperIdentity(artifact: AndroidSnapshotHelperArtifact): {
  packageName: string;
  runner: string;
  helperVersion: string;
  helperVersionCode: number;
  sha256: string;
} {
  return {
    packageName: artifact.manifest.packageName,
    runner: artifact.manifest.instrumentationRunner,
    helperVersion: artifact.manifest.version,
    helperVersionCode: artifact.manifest.versionCode,
    sha256: artifact.manifest.sha256,
  };
}

export async function prepareAndroidAutomationHelper(
  device: DeviceInfo,
  signal?: AbortSignal,
): Promise<PreparedAndroidAutomationHelper> {
  signal?.throwIfAborted();
  const adbProvider = resolveAndroidAdbProvider(device);
  // Same artifact precedence as snapshot capture: a provider-supplied helper artifact overrides
  // the bundled one so both transports install and run the single shared helper (issue #1275).
  const artifact =
    adbProvider.snapshotHelperArtifact ?? (await resolveAndroidAutomationHelperArtifact());
  const deviceKey = getAndroidSnapshotHelperSessionDeviceKey(device);
  await recoverAndroidSnapshotHelperRetirement({
    deviceKey,
    adb: adbProvider.exec,
    signal,
  });
  const install = await withDiagnosticTimer(
    'android_touch_helper_install',
    async () =>
      await ensureAndroidSnapshotHelper({
        adb: adbProvider.exec,
        adbProvider,
        artifact,
        deviceKey,
        timeoutMs: HELPER_INSTALL_TIMEOUT_MS,
        signal,
      }),
    {
      packageName: artifact.manifest.packageName,
      versionCode: artifact.manifest.versionCode,
    },
  );
  emitDiagnostic({
    phase: 'android_touch_helper_install_decision',
    data: install,
  });
  if (install.installed) {
    // An APK replacement kills the running instrumentation, so a persistent session started
    // against the previous binary must not serve this command; the next snapshot restarts it.
    await stopAndroidSnapshotHelperSession(deviceKey, { signal });
  }
  signal?.throwIfAborted();
  return { adb: adbProvider.exec, adbProvider, artifact, install, deviceKey };
}

async function resolveAndroidAutomationHelperArtifact(): Promise<AndroidSnapshotHelperArtifact> {
  return await resolveAndroidHelperArtifact({
    helperDirName: 'snapshot-helper',
    manifestFileName: (version) => `agent-device-android-snapshot-helper-${version}.manifest.json`,
    parseManifest: (value) => {
      const manifest = parseAndroidSnapshotHelperManifest(value);
      return {
        ...manifest,
        assetName:
          manifest.assetName ?? `agent-device-android-snapshot-helper-${manifest.version}.apk`,
      };
    },
    unavailableMessage:
      'Android automation requires the bundled Android automation helper artifact, but it was not found or could not be read',
  });
}
