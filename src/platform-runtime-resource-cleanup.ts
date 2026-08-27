import type { DeviceInfo } from '@agent-device/kernel/device';
import type { OwnedProcessRecordStore } from './utils/owned-process-record.ts';

/** Focused durable-resource cleanup composed above daemon policy and concrete platforms. */
export async function resetAndroidSnapshotHelperRuntime(): Promise<void> {
  const { resetAndroidSnapshotHelperSessions } =
    await import('./platforms/android/snapshot-helper.ts');
  await resetAndroidSnapshotHelperSessions();
}

export async function stopAndroidSnapshotHelperRuntimeForDevice(device: DeviceInfo): Promise<void> {
  const { stopAndroidSnapshotHelperSessionForDevice } =
    await import('./platforms/android/snapshot-helper.ts');
  await stopAndroidSnapshotHelperSessionForDevice(device);
}

export async function cleanupManagedWebRuntimeOrphans(params: {
  stateDir: string;
  openWebSessionNames: readonly string[];
  ownedProcessRecords?: OwnedProcessRecordStore;
}): Promise<void> {
  const { getManagedAgentBrowserStatus } = await import('./platforms/web/agent-browser-tool.ts');
  const status = getManagedAgentBrowserStatus({ stateDir: params.stateDir });
  if (!status.installed) return;
  const { cleanupManagedAgentBrowserOrphans } =
    await import('./platforms/web/agent-browser-lifecycle.ts');
  await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
    openWebSessionNames: params.openWebSessionNames,
    ...(params.ownedProcessRecords === undefined
      ? {}
      : { ownedProcessRecords: params.ownedProcessRecords }),
  });
}

export async function closeManagedWebRuntimeSession(params: {
  sessionName: string;
  stateDir: string;
  openWebSessionNames: () => readonly string[];
}): Promise<void> {
  const { createAgentBrowserWebProvider } =
    await import('./platforms/web/agent-browser-provider.ts');
  await createAgentBrowserWebProvider({
    session: params.sessionName,
    stateDir: params.stateDir,
    openWebSessionNames: params.openWebSessionNames,
  }).close();
}
