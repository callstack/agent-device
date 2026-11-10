import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { isIosFamily, webBackendKeyOf } from '@agent-device/kernel/device';
import type { PlatformResourceCleanup } from '@agent-device/daemon';
import { emitDiagnostic, type ResourceDiagnostic } from '@agent-device/host-kit/diagnostics';
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

/** Only a macOS host has an `XCTestDevices` an older agent-device could have redirected. */
export async function restoreLegacyXctestDeviceSetRedirectRuntime(
  onDiagnostic: (diagnostic: ResourceDiagnostic) => void,
): Promise<void> {
  if (process.platform !== 'darwin') return;
  const { restoreLegacyXctestDeviceSetRedirect } =
    await import('@agent-device/platform-apple/runner-owner');
  await restoreLegacyXctestDeviceSetRedirect(onDiagnostic);
}

export async function cleanupManagedWebRuntimeOrphans(
  params: {
    stateDir: string;
    openWebSessionNames: readonly string[];
    ownedProcessRecords?: OwnedProcessRecordStore;
  },
  host: HostEnvironment,
): Promise<void> {
  const { getManagedAgentBrowserStatus } = await import('@agent-device/platform-web');
  const status = await getManagedAgentBrowserStatus({ stateDir: params.stateDir, host });
  if (!status.installed) return;
  const { cleanupManagedAgentBrowserOrphans } = await import('@agent-device/platform-web');
  await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
    env: host.env,
    openWebSessionNames: params.openWebSessionNames,
    ...(params.ownedProcessRecords === undefined
      ? {}
      : { ownedProcessRecords: params.ownedProcessRecords }),
  });
}

async function closeManagedWebRuntimeSession(
  params: {
    backendKey: string;
    stateDir: string;
    openWebSessionNames: () => readonly string[];
    ownedProcessRecords?: OwnedProcessRecordStore;
  },
  host: HostEnvironment,
): Promise<void> {
  const { createAgentBrowserWebProvider } = await import('@agent-device/platform-web');
  const provider = await createAgentBrowserWebProvider({
    host,
    session: params.backendKey,
    stateDir: params.stateDir,
    openWebSessionNames: params.openWebSessionNames,
    ownedProcessRecords: params.ownedProcessRecords,
  });
  await provider.close();
}

export function createPlatformResourceCleanup(
  host: HostEnvironment,
  ownedProcessRecords?: OwnedProcessRecordStore,
): PlatformResourceCleanup {
  return Object.freeze({
    async stopSnapshotHelper(device) {
      if (device.platform !== 'android') return;
      await stopAndroidSnapshotHelperRuntimeForDevice(device);
    },
    async closeManagedBrowser(params) {
      if (params.device.platform !== 'web') return false;
      const backendKey = webBackendKeyOf(params.device.id);
      if (backendKey === undefined) return false;
      await closeManagedWebRuntimeSession(
        {
          backendKey,
          stateDir: params.stateDir,
          openWebSessionNames: params.openSessionNames,
          ownedProcessRecords,
        },
        host,
      );
      return true;
    },
    async cleanupSessionlessExecutionHost(device) {
      if (!isIosFamily(device)) return;
      const { resolveRunnerAppBundleId, stopIosRunnerSession } =
        await import('@agent-device/platform-apple/runner/operations');
      await stopIosRunnerSession(device.id);
      const bundleId = await resolveRunnerAppBundleId();
      const { closeIosApp } = await import('@agent-device/platform-apple/app-lifecycle');
      await closeIosApp(device, bundleId, undefined, host.env).catch((error) => {
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
        !params.leaseWillEnd
      );
    },
  });
}
