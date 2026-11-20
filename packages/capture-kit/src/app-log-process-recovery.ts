import type {
  AppLogCompletion,
  AppLogLiveHandle,
  AppLogProcessMarkerReadOutcome,
  AppLogRuntimeHost,
} from '@agent-device/contracts/app-log-runtime';
import type { CleanupOutcome, ReattachOutcome } from '@agent-device/contracts/durable-resource';

type ManagedAppLogProcessHost = Readonly<{
  processes: Pick<
    AppLogRuntimeHost['processes'],
    'readMarker' | 'clearMarker' | 'inspect' | 'terminate'
  >;
}>;

export type CleanupOnlyAppLogProcessReattachOutcome = Extract<
  ReattachOutcome<AppLogLiveHandle, AppLogCompletion>,
  { status: 'missing' | 'unreattachable' }
>;

/** A managed process can be cleaned after restart, but cannot reconstruct its live stream handle. */
export async function reattachCleanupOnlyAppLogProcess(
  host: ManagedAppLogProcessHost,
  pidPath?: string,
): Promise<CleanupOnlyAppLogProcessReattachOutcome> {
  const marker = await readManagedMarker(host, pidPath);
  if (marker.status === 'missing') return { status: 'missing' };
  if (marker.status === 'invalid') {
    return {
      status: 'unreattachable',
      reason: 'ownership-fence-lost',
      message: marker.message,
    };
  }
  const ownership = await host.processes.inspect(marker.marker);
  if (ownership === 'missing') {
    if (pidPath) await host.processes.clearMarker(pidPath);
    return { status: 'missing' };
  }
  if (ownership === 'ownership-lost') {
    return { status: 'unreattachable', reason: 'ownership-fence-lost' };
  }
  return { status: 'unreattachable', reason: 'transport-not-reattachable' };
}

/** Cleans only complete, still-owned marker evidence; uncertain evidence remains fail-closed. */
export async function cleanupManagedAppLogProcess(
  host: ManagedAppLogProcessHost,
  pidPath?: string,
): Promise<CleanupOutcome> {
  if (!pidPath) {
    return {
      status: 'cleanup-pending',
      reason: 'manual-recovery-required',
      message: 'App-log process marker path is missing',
    };
  }
  const marker = await readManagedMarker(host, pidPath);
  if (marker.status === 'missing') return { status: 'already-missing' };
  if (marker.status === 'invalid') {
    return {
      status: 'cleanup-pending',
      reason: 'manual-recovery-required',
      message: marker.message,
    };
  }
  const ownership = await host.processes.inspect(marker.marker);
  if (ownership === 'ownership-lost') return ownershipLostCleanup();
  if (ownership === 'missing') {
    await host.processes.clearMarker(pidPath);
    return { status: 'already-missing' };
  }
  const terminated = await host.processes.terminate(marker.marker);
  if (terminated === 'ownership-lost') return ownershipLostCleanup();
  await host.processes.clearMarker(pidPath);
  return { status: terminated === 'terminated' ? 'cleaned' : 'already-missing' };
}

async function readManagedMarker(
  host: ManagedAppLogProcessHost,
  pidPath: string | undefined,
): Promise<AppLogProcessMarkerReadOutcome> {
  return pidPath
    ? await host.processes.readMarker(pidPath)
    : { status: 'invalid', message: 'App-log process marker path is missing' };
}

function ownershipLostCleanup(): CleanupOutcome {
  return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
}
