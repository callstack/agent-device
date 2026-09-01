import type { DeviceInfo } from '@agent-device/kernel/device';
import { isIosFamily } from '@agent-device/kernel/device';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { type OwnedProcessRecordStore } from '@agent-device/host-kit/process';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

/** Focused durable-resource cleanup composed above daemon policy and concrete platforms. */
export async function resetAndroidSnapshotHelperRuntime(): Promise<void> {
  const { resetAndroidSnapshotHelperSessions } = await loadAndroidMechanics();
  await resetAndroidSnapshotHelperSessions();
}

async function stopAndroidSnapshotHelperRuntimeForDevice(device: DeviceInfo): Promise<void> {
  const { stopAndroidSnapshotHelperSessionForDevice } = await loadAndroidMechanics();
  await stopAndroidSnapshotHelperSessionForDevice(device);
}

export async function cleanupManagedWebRuntimeOrphans(params: {
  stateDir: string;
  openWebSessionNames: readonly string[];
  ownedProcessRecords?: OwnedProcessRecordStore;
}): Promise<void> {
  const { getManagedAgentBrowserStatus } = await import('@agent-device/platform-web');
  const status = await getManagedAgentBrowserStatus({ stateDir: params.stateDir });
  if (!status.installed) return;
  const { cleanupManagedAgentBrowserOrphans } = await import('@agent-device/platform-web');
  await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
    openWebSessionNames: params.openWebSessionNames,
    ...(params.ownedProcessRecords === undefined
      ? {}
      : { ownedProcessRecords: params.ownedProcessRecords }),
  });
}

async function closeManagedWebRuntimeSession(params: {
  sessionName: string;
  stateDir: string;
  openWebSessionNames: () => readonly string[];
}): Promise<void> {
  const { createAgentBrowserWebProvider } = await import('@agent-device/platform-web');
  const provider = await createAgentBrowserWebProvider({
    session: params.sessionName,
    stateDir: params.stateDir,
    openWebSessionNames: params.openWebSessionNames,
  });
  await provider.close();
}

export const platformResourceCleanup: PlatformResourceCleanup = Object.freeze({
  async stopSnapshotHelper(device) {
    if (device.platform !== 'android') return;
    await stopAndroidSnapshotHelperRuntimeForDevice(device);
  },
  async closeManagedBrowser(params) {
    if (params.device.platform !== 'web') return;
    await closeManagedWebRuntimeSession({
      sessionName: params.sessionName,
      stateDir: params.stateDir,
      openWebSessionNames: params.openSessionNames,
    });
  },
  async cleanupSessionlessExecutionHost(device) {
    if (!isIosFamily(device)) return;
    const { resolveRunnerAppBundleId, stopIosRunnerSession } =
      await import('@agent-device/platform-apple/runner/operations');
    await stopIosRunnerSession(device.id);
    const bundleId = await resolveRunnerAppBundleId();
    const { closeIosApp } = await import('@agent-device/platform-apple/app-lifecycle');
    await closeIosApp(device, bundleId).catch((error) => {
      emitDiagnostic({
        level: 'debug',
        phase: 'ios_sessionless_runner_host_close_failed',
        data: {
          deviceId: device.id,
          bundleId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
  },
  retainExecutionHostAfterClose(params) {
    return (
      isIosFamily(params.device) &&
      params.device.kind === 'simulator' &&
      !params.shutdownRequested &&
      !params.hasScreenRecording &&
      !params.hasLease &&
      !params.device.simulatorSetPath
    );
  },
});
