import type { PointerTrajectory } from '../../contracts/gesture-plan.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import { AppError } from '../../kernel/errors.ts';
import { execFailureDetails } from '../../utils/exec.ts';
import { emitDiagnostic, withDiagnosticTimer } from '../../utils/diagnostics.ts';
import { resolveAndroidAdbProvider, type AndroidAdbExecutor } from './adb-executor.ts';
import {
  parseInstrumentationRecords,
  readInstrumentationResultNumber,
} from './instrumentation-helper.ts';
import { validateAndroidGestureViewport } from './gesture-viewport.ts';
import type { AndroidTouchPlan } from './touch-plan.ts';
import { resolveAndroidHelperArtifact } from './helper-package-install.ts';
import { parseAndroidSnapshotHelperManifest } from './snapshot-helper-artifact.ts';
import { ensureAndroidSnapshotHelper } from './snapshot-helper-install.ts';
import {
  getAndroidSnapshotHelperSessionDeviceKey,
  runAndroidSnapshotHelperSessionTouchCommand,
  stopAndroidSnapshotHelperSession,
} from './snapshot-helper-session.ts';
import {
  ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  type AndroidSnapshotHelperArtifact,
  type AndroidSnapshotHelperInstallResult,
} from './snapshot-helper-types.ts';

export const ANDROID_TOUCH_PLAN_PROTOCOL = 'android-touch-plan-v1';
const HELPER_GESTURE_TIMEOUT_MS = 45_000;
const HELPER_GESTURE_TIMEOUT_OVERHEAD_MS = 15_000;
const HELPER_VIEWPORT_TIMEOUT_MS = 45_000;
const HELPER_INSTALL_TIMEOUT_MS = 30_000;
const HELPER_NO_FINAL_RESULT = 'ANDROID_TOUCH_HELPER_NO_FINAL_RESULT';
const HELPER_REPORTED_FAILURE = 'ANDROID_TOUCH_HELPER_REPORTED_FAILURE';

type AndroidPlannedPointerTrajectory = {
  pointerId: 0 | 1;
  samples: Array<{ offsetMs: number; x: number; y: number }>;
};

type AndroidTouchHelperGestureRequest = {
  kind: 'swipe' | 'transform';
  durationMs: number;
  pointers: AndroidPlannedPointerTrajectory[];
};

type PreparedAndroidTouchHelper = {
  adb: AndroidAdbExecutor;
  artifact: AndroidSnapshotHelperArtifact;
  install: AndroidSnapshotHelperInstallResult;
  deviceKey: string;
};

export async function executeAndroidTouchHelperPlan(
  device: DeviceInfo,
  plan: AndroidTouchPlan,
): Promise<Record<string, unknown>> {
  const prepared = await prepareAndroidTouchHelper(device);
  const request = normalizeAndroidTouchHelperGestureRequest(plan);
  const timeoutMs = Math.max(
    HELPER_GESTURE_TIMEOUT_MS,
    request.durationMs + HELPER_GESTURE_TIMEOUT_OVERHEAD_MS,
  );
  const payloadBase64 = Buffer.from(
    JSON.stringify({ protocol: ANDROID_TOUCH_PLAN_PROTOCOL, ...request }),
  ).toString('base64');
  const output = await withDiagnosticTimer(
    'android_touch_helper_gesture',
    async () => {
      // A live snapshot session already owns UiAutomation; injecting through it avoids the
      // instrumentation stop/restart that previously taxed every gesture. Gesture session errors
      // are not retried one-shot: events may already be partially injected.
      const sessionHeaders = await runAndroidSnapshotHelperSessionTouchCommand({
        deviceKey: prepared.deviceKey,
        action: 'gesture',
        helper: touchSessionHelperIdentity(prepared.artifact),
        payloadBase64,
        timeoutMs,
      });
      if (sessionHeaders) {
        return { ...readGestureResult(sessionHeaders), helperTransport: 'persistent-session' };
      }
      return {
        ...(await runOneShotTouchHelper({
          adb: prepared.adb,
          runner: prepared.artifact.manifest.instrumentationRunner,
          extraArgs: ['-e', 'mode', 'gesture', '-e', 'payloadBase64', payloadBase64],
          timeoutMs,
          readResult: readGestureResult,
        })),
        helperTransport: 'instrumentation',
      };
    },
    {
      packageName: prepared.artifact.manifest.packageName,
      version: prepared.artifact.manifest.version,
    },
  );
  return {
    backend: 'android-helper',
    helperVersion: prepared.artifact.manifest.version,
    installReason: prepared.install.reason,
    ...output,
  };
}

export async function readAndroidTouchHelperViewport(device: DeviceInfo): Promise<Rect> {
  const prepared = await prepareAndroidTouchHelper(device);
  try {
    const sessionHeaders = await runAndroidSnapshotHelperSessionTouchCommand({
      deviceKey: prepared.deviceKey,
      action: 'viewport',
      helper: touchSessionHelperIdentity(prepared.artifact),
      timeoutMs: HELPER_VIEWPORT_TIMEOUT_MS,
    });
    if (sessionHeaders) return readViewportResult(sessionHeaders);
  } catch (error) {
    // Viewport reads are idempotent, so a fresh one-shot run may still answer. The session must
    // be stopped first: Android permits one instrumentation owner of UiAutomation, and a helper
    // left alive after a structured failure would contend with the one-shot instrumentation.
    await stopAndroidSnapshotHelperSession(prepared.deviceKey);
    emitDiagnostic({
      level: 'warn',
      phase: 'android_touch_helper_viewport_session_fallback',
      data: { reason: error instanceof Error ? error.message : String(error) },
    });
  }
  return await runOneShotTouchHelper({
    adb: prepared.adb,
    runner: prepared.artifact.manifest.instrumentationRunner,
    extraArgs: ['-e', 'mode', 'viewport'],
    timeoutMs: HELPER_VIEWPORT_TIMEOUT_MS,
    readResult: readViewportResult,
  });
}

// Sessions are keyed by device, so reuse must also prove the live session runs the helper binary
// this command selected; a mismatch stops the session and the command falls back to one-shot.
function touchSessionHelperIdentity(artifact: AndroidSnapshotHelperArtifact): {
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

async function prepareAndroidTouchHelper(device: DeviceInfo): Promise<PreparedAndroidTouchHelper> {
  const adbProvider = resolveAndroidAdbProvider(device);
  // Same artifact precedence as snapshot capture: a provider-supplied helper artifact overrides
  // the bundled one so both transports install and run the single shared helper (issue #1275).
  const artifact =
    adbProvider.snapshotHelperArtifact ?? (await resolveAndroidTouchHelperArtifact());
  const deviceKey = getAndroidSnapshotHelperSessionDeviceKey(device);
  const install = await withDiagnosticTimer(
    'android_touch_helper_install',
    async () =>
      await ensureAndroidSnapshotHelper({
        adb: adbProvider.exec,
        adbProvider,
        artifact,
        deviceKey,
        timeoutMs: HELPER_INSTALL_TIMEOUT_MS,
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
    await stopAndroidSnapshotHelperSession(deviceKey);
  }
  return { adb: adbProvider.exec, artifact, install, deviceKey };
}

async function resolveAndroidTouchHelperArtifact(): Promise<AndroidSnapshotHelperArtifact> {
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
      'Android touch gestures require the bundled Android automation helper artifact, but it was not found or could not be read',
  });
}

export function normalizeAndroidTouchHelperGestureRequest(
  plan: AndroidTouchPlan,
): AndroidTouchHelperGestureRequest {
  return {
    kind: plan.topology === 'single' ? 'swipe' : 'transform',
    durationMs: plan.durationMs,
    pointers: plan.pointers.map(toAndroidPlannedPointerTrajectory),
  };
}

function toAndroidPlannedPointerTrajectory(
  pointer: PointerTrajectory,
): AndroidPlannedPointerTrajectory {
  return {
    pointerId: pointer.pointerId,
    samples: pointer.samples.map(({ offsetMs, point }) => ({
      offsetMs,
      x: point.x,
      y: point.y,
    })),
  };
}

async function runOneShotTouchHelper<Result>(options: {
  adb: AndroidAdbExecutor;
  runner: string;
  extraArgs: string[];
  timeoutMs: number;
  readResult: (record: Record<string, string>) => Result;
}): Promise<Result> {
  const result = await options.adb(
    ['shell', 'am', 'instrument', '-w', ...options.extraArgs, options.runner],
    { allowFailure: true, timeoutMs: options.timeoutMs },
  );
  let finalRecord: Record<string, string>;
  try {
    finalRecord = readAndroidTouchHelperFinalRecord(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === HELPER_REPORTED_FAILURE) {
        throw new AppError('COMMAND_FAILED', error.message, error.details, error);
      }
      if (error.code !== HELPER_NO_FINAL_RESULT) throw error;
    }
    throw new AppError(
      'COMMAND_FAILED',
      result.exitCode === 0
        ? 'Android automation helper output could not be parsed'
        : 'Android automation helper failed before returning parseable output',
      execFailureDetails(result),
      error,
    );
  }
  if (result.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android automation helper failed',
      execFailureDetails(result, { helper: finalRecord }),
    );
  }
  return options.readResult(finalRecord);
}

export function readAndroidTouchHelperFinalRecord(output: string): Record<string, string> {
  const finalResult = parseInstrumentationRecords(output).results.find(
    (record) => record.agentDeviceProtocol === ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  );
  if (!finalResult) {
    throw new AppError(
      HELPER_NO_FINAL_RESULT,
      'Android automation helper did not return a final result',
    );
  }
  if (finalResult.ok !== 'true') {
    throw new AppError(
      HELPER_REPORTED_FAILURE,
      finalResult.message && finalResult.message !== 'null'
        ? finalResult.message
        : finalResult.errorType || 'Android automation helper returned an error',
      { errorType: finalResult.errorType, helper: finalResult },
    );
  }
  return finalResult;
}

function readGestureResult(record: Record<string, string>): Record<string, unknown> {
  return {
    helperKind: record.kind,
    helperApiVersion: record.helperApiVersion,
    injectedEvents: readInstrumentationResultNumber(record.injectedEvents),
    elapsedMs: readInstrumentationResultNumber(record.elapsedMs),
  };
}

function readViewportResult(record: Record<string, string>): Rect {
  const x = readInstrumentationResultNumber(record.x);
  const y = readInstrumentationResultNumber(record.y);
  const width = readInstrumentationResultNumber(record.width);
  const height = readInstrumentationResultNumber(record.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    throw new AppError('COMMAND_FAILED', 'Android helper returned an invalid gesture viewport');
  }
  return validateAndroidGestureViewport({ x, y, width, height });
}
