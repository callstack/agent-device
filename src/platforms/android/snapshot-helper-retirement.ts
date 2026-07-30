import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidAdbProcess } from './adb-executor.ts';
import type { AndroidAdbExecutor } from './snapshot-helper-types.ts';

const RETIREMENT_RECOVERY_TIMEOUT_MS = 5_000;
// Host-process termination is local and should be nearly immediate. Device-side force-stop is an
// adb round trip and needs its own budget; sharing the host grace caused healthy CI force-stops to
// time out before Android could confirm UiAutomation release.
export const ANDROID_SNAPSHOT_HELPER_HOST_PROCESS_EXIT_GRACE_MS = 250;
export const ANDROID_SNAPSHOT_HELPER_DEVICE_RETIREMENT_TIMEOUT_MS = 2_000;
const RETIREMENT_UNCONFIRMED_REASON = 'android_snapshot_helper_retirement_unconfirmed';

type UnconfirmedRetirement = {
  packageName: string;
  cause: string;
};

const unconfirmedRetirements = new Map<string, UnconfirmedRetirement>();

export function getAndroidSnapshotHelperSessionDeviceKey(
  device: Pick<DeviceInfo, 'platform' | 'id'>,
): string {
  return `${device.platform}:${device.id}`;
}

export async function retireCanceledAndroidSnapshotHelperCapture(params: {
  deviceKey: string;
  packageName: string;
  adb: AndroidAdbExecutor;
  cause: unknown;
}): Promise<void> {
  const runtimeForceStopped = await forceStopAndroidSnapshotHelperRuntime({
    adb: params.adb,
    packageName: params.packageName,
    timeoutMs: ANDROID_SNAPSHOT_HELPER_DEVICE_RETIREMENT_TIMEOUT_MS,
  });
  if (!runtimeForceStopped) {
    quarantineAndroidSnapshotHelperRetirement(params);
  }
}

export async function recoverAndroidSnapshotHelperRetirement(params: {
  deviceKey: string;
  adb: AndroidAdbExecutor;
  signal?: AbortSignal;
}): Promise<void> {
  const retirement = unconfirmedRetirements.get(params.deviceKey);
  if (!retirement) return;
  try {
    const result = await params.adb(['shell', 'am', 'force-stop', retirement.packageName], {
      allowFailure: true,
      timeoutMs: RETIREMENT_RECOVERY_TIMEOUT_MS,
      signal: params.signal,
    });
    params.signal?.throwIfAborted();
    if (result.exitCode === 0) {
      unconfirmedRetirements.delete(params.deviceKey);
      return;
    }
  } catch {
    params.signal?.throwIfAborted();
  }
  quarantineAndroidSnapshotHelperRetirement({
    deviceKey: params.deviceKey,
    packageName: retirement.packageName,
    cause: retirement.cause,
  });
}

export function quarantineAndroidSnapshotHelperRetirement(params: {
  deviceKey: string;
  packageName: string;
  cause: unknown;
}): never {
  const causeMessage = params.cause instanceof Error ? params.cause.message : String(params.cause);
  unconfirmedRetirements.set(params.deviceKey, {
    packageName: params.packageName,
    cause: causeMessage,
  });
  throw new AppError(
    'COMMAND_FAILED',
    'Android snapshot helper could not confirm release of device automation ownership',
    {
      reason: RETIREMENT_UNCONFIRMED_REASON,
      deviceKey: params.deviceKey,
      cause: causeMessage,
      hint: 'Retry after the helper process exits, or restart the device if Android still reports automation as busy.',
    },
  );
}

export function isAndroidSnapshotHelperRetirementUnconfirmedError(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === RETIREMENT_UNCONFIRMED_REASON;
}

export async function settleAndroidSnapshotHelperSessionCleanup(params: {
  adb: AndroidAdbExecutor;
  process: AndroidAdbProcess;
  port: number;
  packageName: string;
  timeoutMs: number;
}): Promise<{ timedOut: boolean; runtimeForceStopped: boolean }> {
  const signal = AbortSignal.timeout(params.timeoutMs);
  const results = await Promise.allSettled([
    forceStopAndroidSnapshotHelperRuntime({
      adb: params.adb,
      packageName: params.packageName,
      timeoutMs: params.timeoutMs,
      signal,
    }),
    removeAndroidSnapshotHelperSessionForward({ ...params, signal }),
  ] as const);
  const [runtimeStopResult] = results;
  return {
    timedOut: signal.aborted,
    runtimeForceStopped:
      runtimeStopResult?.status === 'fulfilled' ? runtimeStopResult.value : false,
  };
}

export function observeAndroidSnapshotHelperProcessExit(process: AndroidAdbProcess): Promise<void> {
  if (process.exitCode != null || process.signalCode != null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    process.once('close', () => resolve());
    process.once('exit', () => resolve());
  });
}

export async function waitForAndroidSnapshotHelperProcessExit(
  processExit: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const exited = await Promise.race([
    processExit.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
    ...(signal
      ? [
          new Promise<false>((resolve) => {
            onAbort = () => resolve(false);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]
      : []),
  ]);
  if (timer) clearTimeout(timer);
  if (onAbort) signal?.removeEventListener('abort', onAbort);
  return exited;
}

export async function stopAndroidSnapshotHelperHostProcess(params: {
  process: AndroidAdbProcess;
  processExit: Promise<void>;
  alreadyExited: boolean;
  timeoutMs: number;
}): Promise<boolean> {
  if (params.alreadyExited) return true;
  try {
    params.process.kill('SIGTERM');
  } catch {
    // A completed instrumentation process can reject or ignore the signal.
  }
  return await waitForAndroidSnapshotHelperProcessExit(params.processExit, params.timeoutMs);
}

export function resetAndroidSnapshotHelperRetirements(): void {
  unconfirmedRetirements.clear();
}

async function forceStopAndroidSnapshotHelperRuntime(params: {
  adb: AndroidAdbExecutor;
  packageName: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const signal = params.signal ?? AbortSignal.timeout(params.timeoutMs);
  try {
    const result = await params.adb(['shell', 'am', 'force-stop', params.packageName], {
      allowFailure: true,
      timeoutMs: params.timeoutMs,
      signal,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function removeAndroidSnapshotHelperSessionForward(params: {
  adb: AndroidAdbExecutor;
  process: AndroidAdbProcess;
  port: number;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<void> {
  params.process.stdin?.end();
  params.process.stdout?.destroy();
  params.process.stderr?.destroy();
  await params.adb(['forward', '--remove', `tcp:${params.port}`], {
    allowFailure: true,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
}
