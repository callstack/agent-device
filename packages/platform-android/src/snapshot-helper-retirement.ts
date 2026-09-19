import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { shellFragment } from '@agent-device/kernel/device-shell';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';
import { findPidToken } from './perf-native-process.ts';
import { runAdbShell, type AndroidAdbProcess } from './adb-executor.ts';
import type { AndroidAdbExecutor } from './snapshot-helper-types.ts';

const RETIREMENT_RECOVERY_TIMEOUT_MS = 5_000;
// A force-stopped helper can still be inside Android's process-teardown path when the next acquire
// asks who owns the runtime. Refusing a command is a stronger claim than one read supports, so the
// refusal reads the same fact again after this long.
const RUNTIME_OCCUPANCY_RECHECK_MS = 250;
// Host-process termination is local and should be nearly immediate. Device-side force-stop is an
// adb round trip and needs its own budget; sharing the host grace caused healthy CI force-stops to
// time out before Android could confirm UiAutomation release.
export const ANDROID_SNAPSHOT_HELPER_HOST_PROCESS_EXIT_GRACE_MS = 250;
export const ANDROID_SNAPSHOT_HELPER_DEVICE_RETIREMENT_TIMEOUT_MS = 2_000;
const RUNTIME_OCCUPIED_REASON = 'android_snapshot_helper_runtime_occupied';
/**
 * Printed by the device's own shell, and only by it, when the helper process is not running.
 * Exported so a fake device can answer with the real thing.
 */
export const ANDROID_SNAPSHOT_HELPER_NO_HELPER_ANSWER = 'AGENT_DEVICE_NO_HELPER';

/**
 * Whether anything on the device still owns UiAutomation through the helper runtime. `unknown` is
 * reserved for a device that could not be read, never for one that answered slowly or whose
 * `am force-stop` call failed: those say nothing about ownership.
 */
export type AndroidSnapshotHelperRuntimeRelease = 'released' | 'occupied' | 'unknown';

/** A release the last teardown could not prove; settled by the next acquire that reads the device. */
type PendingRetirement = {
  packageName: string;
  cause: string;
};

const pendingRetirements = new Map<string, PendingRetirement>();

export function getAndroidSnapshotHelperSessionDeviceKey(
  device: Pick<DeviceInfo, 'platform' | 'id'>,
): string {
  return `${device.platform}:${device.id}`;
}

/**
 * Stops the runtime a canceled one-shot capture left behind and records what could not be proven.
 * The caller's own outcome — usually a cancellation — is what the caller reports; ownership is a
 * device fact recovered before the next command starts work, not a reason to fail this one.
 */
export async function retireCanceledAndroidSnapshotHelperCapture(params: {
  deviceKey: string;
  packageName: string;
  adb: AndroidAdbExecutor;
  cause: unknown;
}): Promise<void> {
  await stopAndroidSnapshotHelperRuntime({ adb: params.adb, packageName: params.packageName });
  await recordAndroidSnapshotHelperRelease({
    deviceKey: params.deviceKey,
    packageName: params.packageName,
    adb: params.adb,
    cause: params.cause,
  });
}

/**
 * Clears the pending release a previous teardown could not prove, before the next command acquires
 * the device. Only a device that says a helper process is still running may block a command here:
 * an `adb` call that failed or ran out of budget is recorded and the command proceeds, because the
 * transport is exactly what such a call measures badly.
 */
export async function recoverAndroidSnapshotHelperRetirement(params: {
  deviceKey: string;
  adb: AndroidAdbExecutor;
  signal?: AbortSignal;
}): Promise<void> {
  const retirement = pendingRetirements.get(params.deviceKey);
  if (!retirement) return;
  await stopAndroidSnapshotHelperRuntime({
    adb: params.adb,
    packageName: retirement.packageName,
    timeoutMs: RETIREMENT_RECOVERY_TIMEOUT_MS,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  let release = await readAndroidSnapshotHelperRuntimeRelease({
    adb: params.adb,
    packageName: retirement.packageName,
  });
  if (release === 'occupied') {
    // A helper that was force-stopped a moment ago can still be inside Android's exit path while
    // `pidof` answers. Refusing a command is the strongest claim this function makes, so it is the
    // one that asks the device twice.
    await sleep(RUNTIME_OCCUPANCY_RECHECK_MS);
    release = await readAndroidSnapshotHelperRuntimeRelease({
      adb: params.adb,
      packageName: retirement.packageName,
    });
  }
  if (release === 'occupied') {
    throw createAndroidSnapshotHelperRuntimeOccupiedError({
      deviceKey: params.deviceKey,
      packageName: retirement.packageName,
      cause: retirement.cause,
    });
  }
  // A device that could not be read leaves the retirement pending: the next acquire asks again, and
  // this command answers for its own transport instead of for ownership.
  if (release === 'unknown') return;
  pendingRetirements.delete(params.deviceKey);
}

/**
 * Records what one teardown proved about device automation ownership: nothing a command reports
 * through. A release the device confirmed clears the pending retirement; anything else keeps it for
 * the next acquire, which is where a command may be refused for it.
 */
export async function recordAndroidSnapshotHelperRelease(params: {
  deviceKey: string;
  packageName: string;
  adb: AndroidAdbExecutor;
  cause: unknown;
  /** Release the caller already proved, for example by an acknowledged and clean helper quit. */
  release?: AndroidSnapshotHelperRuntimeRelease;
}): Promise<AndroidSnapshotHelperRuntimeRelease> {
  const release =
    params.release ??
    (await readAndroidSnapshotHelperRuntimeRelease({
      adb: params.adb,
      packageName: params.packageName,
    }));
  if (release === 'released') {
    pendingRetirements.delete(params.deviceKey);
    return release;
  }
  const causeMessage = params.cause instanceof Error ? params.cause.message : String(params.cause);
  pendingRetirements.set(params.deviceKey, {
    packageName: params.packageName,
    cause: causeMessage,
  });
  emitDiagnostic({
    level: 'warn',
    phase: 'android_snapshot_helper_retirement_pending',
    data: { deviceKey: params.deviceKey, packageName: params.packageName, release },
  });
  return release;
}

export function isAndroidSnapshotHelperRuntimeOccupiedError(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === RUNTIME_OCCUPIED_REASON;
}

function createAndroidSnapshotHelperRuntimeOccupiedError(params: {
  deviceKey: string;
  packageName: string;
  cause: unknown;
}): AppError {
  const causeMessage = params.cause instanceof Error ? params.cause.message : String(params.cause);
  return new AppError(
    'COMMAND_FAILED',
    'Android automation helper is still holding device automation ownership',
    {
      reason: RUNTIME_OCCUPIED_REASON,
      deviceKey: params.deviceKey,
      packageName: params.packageName,
      cause: causeMessage,
      hint: 'Retry after the helper process exits, or restart the device if Android keeps reporting the helper as running.',
    },
  );
}

/**
 * Asks the device who owns UiAutomation. Android drops the connection with the process that opened
 * it, so a helper package with no process cannot be holding the device.
 */
async function readAndroidSnapshotHelperRuntimeRelease(params: {
  adb: AndroidAdbExecutor;
  packageName: string;
}): Promise<AndroidSnapshotHelperRuntimeRelease> {
  try {
    // The marker comes from the device shell, and only from it, so a release is claimed by an answer
    // the transport cannot forge: an adb client that ran out of budget, was killed by a signal, or
    // lost the connection prints nothing at all. No exit status is consulted either, because `adb
    // shell` answers 0 for a device command that failed and the executor has to invent one when the
    // client dies before reporting one.
    const result = await runAdbShell(
      params.adb,
      [
        'pidof',
        params.packageName,
        // `||` is device-shell syntax, not a value: it stays a fragment so the shell parses it as the
        // fallback operator instead of receiving a literal `||` argument.
        shellFragment(`|| echo ${ANDROID_SNAPSHOT_HELPER_NO_HELPER_ANSWER}`),
      ],
      { allowFailure: true, timeoutMs: ANDROID_SNAPSHOT_HELPER_DEVICE_RETIREMENT_TIMEOUT_MS },
    );
    const stdout = result.stdout.trim();
    if (findPidToken(stdout)) return 'occupied';
    // A shell with no `pidof` prints the marker too, after it complains, so the answer counts only
    // from a shell that had nothing to say about the command it ran.
    return stdout === ANDROID_SNAPSHOT_HELPER_NO_HELPER_ANSWER && result.stderr.trim().length === 0
      ? 'released'
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function settleAndroidSnapshotHelperSessionCleanup(params: {
  adb: AndroidAdbExecutor;
  process: AndroidAdbProcess;
  port: number;
  packageName: string;
  timeoutMs: number;
  /**
   * Whether the device runtime still needs `am force-stop`. Only a quit the helper acknowledged
   * AND then completed cleanly proves UiAutomation was released; every forced, timed-out, or
   * aborted teardown must still stop the runtime, because a daemon that dies without sending
   * `quit` would otherwise leave the helper squatting UiAutomation for the next command. Recovery
   * paths that distrust the helper's output require the stop regardless of that evidence.
   */
  forceStopRuntime: boolean;
}): Promise<{ timedOut: boolean }> {
  const signal = AbortSignal.timeout(params.timeoutMs);
  await Promise.all([
    ...(params.forceStopRuntime
      ? [
          stopAndroidSnapshotHelperRuntime({
            adb: params.adb,
            packageName: params.packageName,
            timeoutMs: params.timeoutMs,
            signal,
          }),
        ]
      : []),
    removeAndroidSnapshotHelperSessionForward({ ...params, signal }),
  ]);
  return { timedOut: signal.aborted };
}

/**
 * Watches one host `adb shell am instrument` child, and remembers whether the end it saw is
 * evidence that the instrumentation FINISHED rather than that the transport merely died.
 */
export type AndroidSnapshotHelperProcessExit = {
  /** Resolves when the process is gone — already resolved when it was gone before observation. */
  ended: Promise<void>;
  /** Whether the process is gone, by any cause. */
  hasEnded(): boolean;
  /**
   * Whether this observation started on a live process that then exited with code 0 and no
   * terminating signal. A signal, a non-zero code, or a process that was already gone says the
   * host child died: adb restarted, the transport dropped, something killed it. None of those say
   * the device-side helper released UiAutomation — it can outlive its host through an open forward.
   */
  completedCleanly(): boolean;
};

export function observeAndroidSnapshotHelperProcessExit(
  childProcess: AndroidAdbProcess,
): AndroidSnapshotHelperProcessExit {
  const endedBeforeObservation = hasAndroidSnapshotHelperProcessEnded(childProcess);
  const ended = endedBeforeObservation
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        childProcess.once('close', () => resolve());
        childProcess.once('exit', () => resolve());
      });
  return {
    ended,
    hasEnded: () => hasAndroidSnapshotHelperProcessEnded(childProcess),
    completedCleanly: () =>
      !endedBeforeObservation && childProcess.exitCode === 0 && childProcess.signalCode == null,
  };
}

/** Whether the host side of an instrumentation session is already gone. */
export function hasAndroidSnapshotHelperProcessEnded(childProcess: AndroidAdbProcess): boolean {
  return childProcess.exitCode != null || childProcess.signalCode != null;
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
  processExit: AndroidSnapshotHelperProcessExit;
  timeoutMs: number;
}): Promise<boolean> {
  if (params.processExit.hasEnded()) return true;
  try {
    params.process.kill('SIGTERM');
  } catch {
    // A completed instrumentation process can reject or ignore the signal.
  }
  return await waitForAndroidSnapshotHelperProcessExit(params.processExit.ended, params.timeoutMs);
}

/**
 * Settles a release the last teardown could not prove, from the other end of the device. The fact
 * that settles it is Android's, not ours: `am instrument` for a package that is already instrumenting
 * force-stops that process first, so a helper that reached ready — which it reports straight after
 * binding its session socket, before it asks for UiAutomation — is the only helper process the device
 * still has. Whatever the old process held is gone with it. The session lifecycle calls this on the
 * way to ready; an unreadable `pidof` must not leave a pending entry that force-stops a live helper
 * on the next acquire. Should the helper ever start sharing its package with another instrumentation
 * target, or report readiness after acquiring UiAutomation instead of before, this settles on a
 * process that may not be the only one, and the pending entry has to stay.
 */
export function settleAndroidSnapshotHelperRetirement(deviceKey: string): void {
  pendingRetirements.delete(deviceKey);
}

export function resetAndroidSnapshotHelperRetirements(): void {
  pendingRetirements.clear();
}

/**
 * Best-effort device-side stop. Its outcome is never release evidence: whoever needs that reads the
 * device with `readAndroidSnapshotHelperRuntimeRelease`.
 */
export async function stopAndroidSnapshotHelperRuntime(params: {
  adb: AndroidAdbExecutor;
  packageName: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  await runAdbShell(params.adb, ['am', 'force-stop', params.packageName], {
    allowFailure: true,
    timeoutMs: params.timeoutMs ?? ANDROID_SNAPSHOT_HELPER_DEVICE_RETIREMENT_TIMEOUT_MS,
    ...(params.signal ? { signal: params.signal } : {}),
  }).catch(() => {});
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
