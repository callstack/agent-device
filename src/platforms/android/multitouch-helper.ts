import type { GesturePlan, PointerTrajectory } from '../../contracts/gesture-plan.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import { execFailureDetails } from '../../utils/exec.ts';
import { emitDiagnostic, withDiagnosticTimer } from '../../utils/diagnostics.ts';
import {
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveAndroidGestureViewportProvider,
  resolveAndroidTouchInjector,
  type AndroidAdbExecutor,
} from './adb-executor.ts';
import {
  makeEnsureAndroidHelperInstalled,
  resolveAndroidHelperArtifact,
} from './helper-package-install.ts';
import {
  parseInstrumentationRecords,
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
  readAndroidHelperManifestSha256,
  readAndroidHelperManifestString,
  readInstrumentationResultNumber,
} from './instrumentation-helper.ts';
import { stopAndroidSnapshotHelperSessionForDevice } from './snapshot-helper.ts';
import { swipeAndroid } from './input-actions.ts';

const HELPER_NAME = 'android-multitouch-helper';
const HELPER_PACKAGE = 'com.callstack.agentdevice.multitouchhelper';
const HELPER_RUNNER = 'com.callstack.agentdevice.multitouchhelper/.MultiTouchInstrumentation';
const HELPER_PROTOCOL = 'android-multitouch-helper-v1';
const HELPER_INSTALL_TIMEOUT_MS = 30_000;
const HELPER_GESTURE_TIMEOUT_MS = 45_000;
const HELPER_NO_FINAL_RESULT = 'ANDROID_MULTITOUCH_HELPER_NO_FINAL_RESULT';
const HELPER_REPORTED_FAILURE = 'ANDROID_MULTITOUCH_HELPER_REPORTED_FAILURE';
const HELPER_LABEL = 'Android multi-touch helper';
const MANIFEST_HELPER_LABEL = 'multi-touch helper';

type AndroidMultiTouchHelperManifest = {
  name: 'android-multitouch-helper';
  version: string;
  assetName: string;
  sha256: string;
  packageName: string;
  versionCode: number;
  instrumentationRunner: string;
  statusProtocol: 'android-multitouch-helper-v1';
};

type AndroidMultiTouchHelperArtifact = {
  apkPath: string;
  manifest: AndroidMultiTouchHelperManifest;
};

type AndroidPlannedPointerTrajectory = {
  pointerId: 0 | 1;
  samples: Array<{ offsetMs: number; x: number; y: number }>;
};

type AndroidMultiTouchHelperGestureRequest = {
  kind: 'swipe' | 'transform';
  durationMs: number;
  pointers: AndroidPlannedPointerTrajectory[];
};

export async function performGestureAndroid(
  device: DeviceInfo,
  plan: GesturePlan,
): Promise<Record<string, unknown>> {
  const providerTouch = resolveAndroidTouchInjector(device);
  if (providerTouch) {
    const result = (await providerTouch(plan)) ?? {};
    return { backend: 'provider-native-touch', ...result };
  }
  try {
    return await runAndroidMultiTouchHelperGestureForDevice(device, plan);
  } catch (error) {
    if (plan.topology === 'two') throw error;
    emitDiagnostic({
      level: 'warn',
      phase: 'android_swipe_helper_fallback',
      data: { error: normalizeError(error).message },
    });
    const first = plan.pointers[0].samples[0]?.point;
    const last = plan.pointers[0].samples.at(-1)?.point;
    if (!first || !last) throw error;
    await swipeAndroid(device, first.x, first.y, last.x, last.y, plan.durationMs);
    return { backend: 'adb-input-swipe-fallback' };
  }
}

async function runAndroidMultiTouchHelperGestureForDevice(
  device: DeviceInfo,
  plan: GesturePlan,
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

export async function readAndroidGestureViewport(device: DeviceInfo): Promise<Rect> {
  const providerViewport = resolveAndroidGestureViewportProvider(device);
  if (providerViewport) return validateAndroidGestureViewport(await providerViewport());
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
  if (result.exitCode !== 0)
    throw new AppError('COMMAND_FAILED', 'Android gesture viewport is unavailable');
  return parseAndroidGestureViewportResult(records.results);
}

export function parseAndroidGestureViewportResult(results: Array<Record<string, string>>): Rect {
  const output = results.find((record) => record.agentDeviceProtocol === HELPER_PROTOCOL);
  if (output?.ok !== 'true')
    throw new AppError(
      'COMMAND_FAILED',
      output?.message || 'Android gesture viewport is unavailable',
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

function validateAndroidGestureViewport(viewport: Rect): Rect {
  if (
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    throw new AppError('COMMAND_FAILED', 'Android helper returned an invalid gesture viewport');
  return viewport;
}

export function normalizeAndroidMultiTouchHelperGestureRequest(
  plan: GesturePlan,
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
    { allowFailure: true, timeoutMs: HELPER_GESTURE_TIMEOUT_MS },
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

async function resolveAndroidMultiTouchHelperArtifact(): Promise<AndroidMultiTouchHelperArtifact> {
  return await resolveAndroidHelperArtifact({
    helperDirName: 'android-multitouch-helper',
    manifestFileName: (version) =>
      `agent-device-android-multitouch-helper-${version}.manifest.json`,
    parseManifest: parseAndroidMultiTouchHelperManifest,
    unavailableMessage:
      'Android touch gestures require the bundled Android touch helper artifact, but it was not found or could not be read',
  });
}

function parseAndroidMultiTouchHelperManifest(value: unknown): AndroidMultiTouchHelperManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'Android multi-touch helper manifest must be an object.');
  }
  const record = value as Record<string, unknown>;
  return {
    name: readAndroidHelperManifestLiteral(record.name, 'name', HELPER_NAME, MANIFEST_HELPER_LABEL),
    version: readAndroidHelperManifestString(record.version, 'version', MANIFEST_HELPER_LABEL),
    assetName: readAndroidHelperManifestString(
      record.assetName,
      'assetName',
      MANIFEST_HELPER_LABEL,
    ),
    sha256: readAndroidHelperManifestSha256(record.sha256, MANIFEST_HELPER_LABEL),
    packageName: readAndroidHelperManifestLiteral(
      record.packageName,
      'packageName',
      HELPER_PACKAGE,
      MANIFEST_HELPER_LABEL,
    ),
    versionCode: readAndroidHelperManifestInteger(
      record.versionCode,
      'versionCode',
      MANIFEST_HELPER_LABEL,
    ),
    instrumentationRunner: readAndroidHelperManifestLiteral(
      record.instrumentationRunner,
      'instrumentationRunner',
      HELPER_RUNNER,
      MANIFEST_HELPER_LABEL,
    ),
    statusProtocol: readAndroidHelperManifestLiteral(
      record.statusProtocol,
      'statusProtocol',
      HELPER_PROTOCOL,
      MANIFEST_HELPER_LABEL,
    ),
  };
}

const installedMultiTouchHelpers = new Set<string>();

export const ensureAndroidMultiTouchHelper =
  makeEnsureAndroidHelperInstalled<AndroidMultiTouchHelperArtifact>({
    cache: installedMultiTouchHelpers,
    installTimeoutMs: HELPER_INSTALL_TIMEOUT_MS,
    helperLabel: HELPER_LABEL,
  });

export function resetAndroidMultiTouchHelperInstallCache(): void {
  installedMultiTouchHelpers.clear();
}
