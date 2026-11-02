import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { normalizeError } from '@agent-device/kernel/errors';
import { sleep } from './adb.ts';
import type { AndroidAdbExecutor } from './adb-executor.ts';
import { stopAndroidSnapshotHelperRuntime } from './snapshot-helper-retirement.ts';
import { isAndroidSnapshotHelperStartFailure } from './snapshot-helper-capture.ts';
import { stopAndroidSnapshotHelperSession } from './snapshot-helper-session-lifecycle.ts';

const HELPER_RUNTIME_RESET_DELAY_MS = 150;

export async function retireAndroidSnapshotHelperAfterContentFailure(params: {
  adb: AndroidAdbExecutor;
  deviceKey: string;
  packageName: string;
  signal?: AbortSignal;
  cause: unknown;
}): Promise<void> {
  const retiredPersistentSession = await stopAndroidSnapshotHelperSession(params.deviceKey, {
    // Content failure is a recovery path, not a clean release: the helper answered with output we
    // could not trust, so the next capture must meet a runtime that was reset. The session stop
    // owns that reset, so it is required here rather than layered on afterwards.
    resetRuntime: true,
    signal: params.signal,
    cause: params.cause,
  });
  params.signal?.throwIfAborted();
  if (!retiredPersistentSession) {
    // The suspect helper ran one-shot, so no session stop reset the runtime for us.
    await resetAndroidSnapshotHelperRuntime({ adb: params.adb, packageName: params.packageName });
  }
}

/** A cancelled `signal` ends the reset early; the caller decides what a cancellation answers. */
export async function resetAndroidSnapshotHelperRuntime(params: {
  adb: AndroidAdbExecutor;
  packageName: string;
  signal?: AbortSignal;
}): Promise<void> {
  await stopAndroidSnapshotHelperRuntime(params);
  await sleep(HELPER_RUNTIME_RESET_DELAY_MS, params.signal);
  // A cancelled reset may have cut the force-stop or the settle short, so it does not report one.
  if (params.signal?.aborted) return;
  emitDiagnostic({
    level: 'debug',
    phase: 'android_snapshot_helper_runtime_reset',
    data: { packageName: params.packageName },
  });
}

/**
 * Runs a one-shot helper capture. Right after a boot or a `/data` restore, the system can refuse to
 * start a current helper once and start it on the next run (#4109). When no session was ready for
 * this capture and the system refused the start, nothing ran on the device, so the helper gets
 * exactly one more start after a runtime reset. Any other failure is the answer.
 */
export async function captureRetryingRefusedAndroidSnapshotHelperStart<Output>(params: {
  capture: () => Promise<Output>;
  sessionReady: boolean;
  adb: AndroidAdbExecutor;
  packageName: string;
  signal?: AbortSignal;
}): Promise<Output> {
  try {
    return await params.capture();
  } catch (error) {
    params.signal?.throwIfAborted();
    if (params.sessionReady || !isAndroidSnapshotHelperStartFailure(error)) throw error;
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_helper_start_retry',
      data: { instrumentation: normalizeError(error).details?.instrumentation },
    });
    await resetAndroidSnapshotHelperRuntime(params);
    params.signal?.throwIfAborted();
    return await params.capture();
  }
}
