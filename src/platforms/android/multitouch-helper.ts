import type { PointerTrajectory } from '../../contracts/gesture-plan.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import { AppError } from '../../kernel/errors.ts';
import { execFailureDetails } from '../../utils/exec.ts';
import { emitDiagnostic, withDiagnosticTimer } from '../../utils/diagnostics.ts';
import {
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  type AndroidAdbExecutor,
} from './adb-executor.ts';
import {
  parseInstrumentationRecords,
  readInstrumentationResultNumber,
} from './instrumentation-helper.ts';
import { stopAndroidSnapshotHelperSessionForDevice } from './snapshot-helper.ts';
import { validateAndroidGestureViewport } from './gesture-viewport.ts';
import type { AndroidTouchPlan } from './touch-plan.ts';
import {
  ANDROID_MULTITOUCH_HELPER_PROTOCOL,
  ensureAndroidMultiTouchHelper,
  resolveAndroidMultiTouchHelperArtifact,
} from './multitouch-helper-install.ts';

const HELPER_PROTOCOL = ANDROID_MULTITOUCH_HELPER_PROTOCOL;
const HELPER_GESTURE_TIMEOUT_MS = 45_000;
const HELPER_GESTURE_TIMEOUT_OVERHEAD_MS = 15_000;
const HELPER_NO_FINAL_RESULT = 'ANDROID_MULTITOUCH_HELPER_NO_FINAL_RESULT';
const HELPER_REPORTED_FAILURE = 'ANDROID_MULTITOUCH_HELPER_REPORTED_FAILURE';

type AndroidPlannedPointerTrajectory = {
  pointerId: 0 | 1;
  samples: Array<{ offsetMs: number; x: number; y: number }>;
};

type AndroidMultiTouchHelperGestureRequest = {
  kind: 'swipe' | 'transform';
  durationMs: number;
  pointers: AndroidPlannedPointerTrajectory[];
};

export async function executeAndroidMultiTouchHelperPlan(
  device: DeviceInfo,
  plan: AndroidTouchPlan,
): Promise<Record<string, unknown>> {
  const { adb, artifact, install } = await prepareAndroidMultiTouchHelper(device);
  const output = await withDiagnosticTimer(
    'android_multitouch_helper_gesture',
    async () =>
      await runAndroidMultiTouchHelperGesture({
        adb,
        request: normalizeAndroidMultiTouchHelperGestureRequest(plan),
        packageName: artifact.manifest.packageName,
        instrumentationRunner: artifact.manifest.instrumentationRunner,
      }),
    { packageName: artifact.manifest.packageName, version: artifact.manifest.version },
  );
  return {
    backend: 'android-multitouch-helper',
    helperVersion: artifact.manifest.version,
    installReason: install.reason,
    ...output,
  };
}

async function prepareAndroidMultiTouchHelper(device: DeviceInfo) {
  const adb = resolveAndroidAdbExecutor(device);
  const artifact = await resolveAndroidMultiTouchHelperArtifact();
  const install = await withDiagnosticTimer(
    'android_multitouch_helper_install',
    async () =>
      await ensureAndroidMultiTouchHelper({
        adb,
        adbProvider: resolveAndroidAdbProvider(device),
        artifact,
        deviceKey: `${device.platform}:${device.id}`,
      }),
    {
      packageName: artifact.manifest.packageName,
      versionCode: artifact.manifest.versionCode,
    },
  );
  emitDiagnostic({
    phase: 'android_multitouch_helper_install_decision',
    data: install,
  });
  await stopAndroidSnapshotHelperSessionForDevice(device);
  return { adb, artifact, install };
}

export async function readAndroidMultiTouchHelperViewport(device: DeviceInfo): Promise<Rect> {
  const { adb, artifact } = await prepareAndroidMultiTouchHelper(device);
  const result = await adb(
    [
      'shell',
      'am',
      'instrument',
      '-w',
      '-e',
      'mode',
      'viewport',
      artifact.manifest.instrumentationRunner,
    ],
    { allowFailure: true, timeoutMs: HELPER_GESTURE_TIMEOUT_MS },
  );
  const records = parseInstrumentationRecords(`${result.stdout}\n${result.stderr}`);
  if (result.exitCode === 0) return parseAndroidGestureViewportResult(records.results);
  if (records.results.some((record) => record.agentDeviceProtocol === HELPER_PROTOCOL)) {
    parseAndroidGestureViewportResult(records.results);
  }
  throw new AppError(
    'COMMAND_FAILED',
    'Android gesture viewport is unavailable',
    execFailureDetails(result),
  );
}

export function parseAndroidGestureViewportResult(results: Array<Record<string, string>>): Rect {
  const output = results.find((record) => record.agentDeviceProtocol === HELPER_PROTOCOL);
  if (output?.ok !== 'true')
    throw new AppError(
      'COMMAND_FAILED',
      output?.message || 'Android gesture viewport is unavailable',
      output ? { errorType: output.errorType, helper: output } : undefined,
    );
  const x = readInstrumentationResultNumber(output.x);
  const y = readInstrumentationResultNumber(output.y);
  const width = readInstrumentationResultNumber(output.width);
  const height = readInstrumentationResultNumber(output.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    throw new AppError('COMMAND_FAILED', 'Android helper returned an invalid gesture viewport');
  }
  return validateAndroidGestureViewport({ x, y, width, height });
}

export function normalizeAndroidMultiTouchHelperGestureRequest(
  plan: AndroidTouchPlan,
): AndroidMultiTouchHelperGestureRequest {
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

export async function runAndroidMultiTouchHelperGesture(options: {
  adb: AndroidAdbExecutor;
  request: AndroidMultiTouchHelperGestureRequest;
  packageName: string;
  instrumentationRunner: string;
}): Promise<Record<string, unknown>> {
  const payloadBase64 = Buffer.from(
    JSON.stringify({ protocol: HELPER_PROTOCOL, ...options.request }),
  ).toString('base64');
  const result = await options.adb(
    [
      'shell',
      'am',
      'instrument',
      '-w',
      '-e',
      'payloadBase64',
      payloadBase64,
      options.instrumentationRunner,
    ],
    {
      allowFailure: true,
      timeoutMs: Math.max(
        HELPER_GESTURE_TIMEOUT_MS,
        options.request.durationMs + HELPER_GESTURE_TIMEOUT_OVERHEAD_MS,
      ),
    },
  );
  let output: Record<string, unknown>;
  try {
    output = parseAndroidMultiTouchHelperOutput(`${result.stdout}\n${result.stderr}`);
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
        ? 'Android multi-touch helper output could not be parsed'
        : 'Android multi-touch helper failed before returning parseable output',
      execFailureDetails(result),
      error,
    );
  }
  if (result.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android multi-touch helper failed',
      execFailureDetails(result, { helper: output }),
    );
  }
  return output;
}

export function parseAndroidMultiTouchHelperOutput(output: string): Record<string, unknown> {
  const finalResult = parseInstrumentationRecords(output).results.find(
    (record) => record.agentDeviceProtocol === HELPER_PROTOCOL,
  );
  if (!finalResult) {
    throw new AppError(
      HELPER_NO_FINAL_RESULT,
      'Android multi-touch helper did not return a final result',
    );
  }
  if (finalResult.ok !== 'true') {
    throw new AppError(
      HELPER_REPORTED_FAILURE,
      finalResult.message && finalResult.message !== 'null'
        ? finalResult.message
        : finalResult.errorType || 'Android multi-touch helper returned an error',
      { errorType: finalResult.errorType, helper: finalResult },
    );
  }
  return {
    helperKind: finalResult.kind,
    helperApiVersion: finalResult.helperApiVersion,
    injectedEvents: readInstrumentationResultNumber(finalResult.injectedEvents),
    elapsedMs: readInstrumentationResultNumber(finalResult.elapsedMs),
  };
}
