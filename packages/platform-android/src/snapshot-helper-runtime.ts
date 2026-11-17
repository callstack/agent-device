import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { normalizeError } from '@agent-device/kernel/errors';
import { sleep } from './adb.ts';
import type { AndroidAdbExecutor, AndroidAdbProvider } from './adb-executor.ts';
import {
  ANDROID_SNAPSHOT_HELPER_CAPTURE_TIMEOUT_MS,
  ANDROID_SNAPSHOT_HELPER_COMMAND_TIMEOUT_MS,
  type AndroidSnapshotHelperArtifact,
  type AndroidSnapshotHelperCaptureOptions,
  type AndroidSnapshotHelperOutput,
  type AndroidSnapshotHelperTransport,
} from './snapshot-helper-types.ts';
import {
  isAndroidSnapshotHelperRuntimeOccupiedError,
  stopAndroidSnapshotHelperRuntime,
} from './snapshot-helper-retirement.ts';
import {
  buildAndroidSnapshotHelperCaptureOptions,
  captureAndroidSnapshotWithHelper,
  isAndroidSnapshotHelperStartFailure,
} from './snapshot-helper-capture.ts';
import {
  acquireAndroidSnapshotHelperSession,
  stopAndroidSnapshotHelperSession,
  type AndroidSnapshotHelperSession,
} from './snapshot-helper-session-lifecycle.ts';
import {
  captureBorrowedAndroidSnapshotHelperSession,
  captureFromAndroidSnapshotHelperSession,
} from './snapshot-helper-session.ts';

const HELPER_RUNTIME_RESET_DELAY_MS = 150;

/**
 * The diagnostic phase of a capture through the snapshot helper's persistent session. Its
 * `data.transport` names the session transport, and `data.answered` is false when the session
 * returned no capture (off, backed off, failed to start, or retired) and a one-shot capture follows.
 */
export const ANDROID_SNAPSHOT_HELPER_SESSION_CAPTURE_PHASE =
  'android_snapshot_helper_session_capture';
/**
 * The diagnostic phase of a one-shot `am instrument` snapshot helper capture. Its `data.transport`
 * names the instrumentation transport.
 */
export const ANDROID_SNAPSHOT_HELPER_CAPTURE_PHASE = 'android_snapshot_helper_capture';

export async function captureAndroidUiHierarchyFromHelper(params: {
  idleWait?: AndroidSnapshotHelperCaptureOptions['idleWait'];
  signal?: AbortSignal;
  adb: AndroidAdbExecutor;
  adbProvider: AndroidAdbProvider;
  artifact: AndroidSnapshotHelperArtifact;
  helperDeviceKey: string;
  borrowedSession?: AndroidSnapshotHelperSession;
}): Promise<AndroidSnapshotHelperOutput> {
  const { signal, adb, adbProvider, artifact, helperDeviceKey, borrowedSession } = params;
  const captureOptions = buildAndroidSnapshotHelperCaptureOptions({
    adb,
    adbProvider,
    artifact,
    deviceKey: helperDeviceKey,
    signal,
  });
  captureOptions.idleWait = params.idleWait;
  let sessionCapture: AndroidSnapshotHelperOutput | undefined;
  // A helper that reached a ready session was started, so a refused start after it is not #4109.
  let sessionReady = false;
  try {
    await withDiagnosticTimer(
      ANDROID_SNAPSHOT_HELPER_SESSION_CAPTURE_PHASE,
      async () => {
        if (borrowedSession) {
          sessionCapture = await captureBorrowedAndroidSnapshotHelperSession(
            borrowedSession,
            captureOptions,
          );
          return;
        }
        const acquired = await acquireAndroidSnapshotHelperSession(captureOptions);
        sessionReady = acquired !== undefined;
        if (acquired) {
          sessionCapture = await captureFromAndroidSnapshotHelperSession(acquired, captureOptions);
        }
      },
      () => ({
        packageName: artifact.manifest.packageName,
        version: artifact.manifest.version,
        timeoutMs: ANDROID_SNAPSHOT_HELPER_CAPTURE_TIMEOUT_MS,
        transport: 'persistent-session' satisfies AndroidSnapshotHelperTransport,
        answered: sessionCapture !== undefined,
      }),
    );
    if (sessionCapture) return sessionCapture;
  } catch (error) {
    signal?.throwIfAborted();
    if (borrowedSession || isAndroidSnapshotHelperRuntimeOccupiedError(error)) {
      throw error;
    }
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_helper_session_fallback',
      data: { reason: normalizeError(error).message },
    });
    await resetAndroidSnapshotHelperRuntime({ adb, packageName: artifact.manifest.packageName });
  }
  const captureOneShot = async () =>
    await withDiagnosticTimer(
      ANDROID_SNAPSHOT_HELPER_CAPTURE_PHASE,
      async () => await captureAndroidSnapshotWithHelper(captureOptions),
      {
        packageName: artifact.manifest.packageName,
        version: artifact.manifest.version,
        timeoutMs: ANDROID_SNAPSHOT_HELPER_CAPTURE_TIMEOUT_MS,
        commandTimeoutMs: ANDROID_SNAPSHOT_HELPER_COMMAND_TIMEOUT_MS,
        transport: 'instrumentation' satisfies AndroidSnapshotHelperTransport,
      },
    );
  return await captureRetryingRefusedAndroidSnapshotHelperStart({
    capture: captureOneShot,
    sessionReady,
    adb,
    packageName: artifact.manifest.packageName,
    signal,
  });
}

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
async function captureRetryingRefusedAndroidSnapshotHelperStart(params: {
  capture: () => Promise<AndroidSnapshotHelperOutput>;
  sessionReady: boolean;
  adb: AndroidAdbExecutor;
  packageName: string;
  signal?: AbortSignal;
}): Promise<AndroidSnapshotHelperOutput> {
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
