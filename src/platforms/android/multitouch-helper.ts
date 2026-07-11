import { AppError, normalizeError } from '../../kernel/errors.ts';
import { execFailureDetails } from '../../utils/exec.ts';
import { emitDiagnostic, withDiagnosticTimer } from '../../utils/diagnostics.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { TransformGestureParams } from '../../contracts/scroll-gesture.ts';
import {
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveAndroidTouchInjector,
  type AndroidAdbExecutor,
  type AndroidTouchGestureRequest,
} from './adb-executor.ts';
import { getAndroidScreenSize, swipeAndroid } from './input-actions.ts';
import {
  parseInstrumentationRecords,
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
  readAndroidHelperManifestSha256,
  readAndroidHelperManifestString,
  readInstrumentationResultNumber,
} from './instrumentation-helper.ts';
import {
  makeEnsureAndroidHelperInstalled,
  resolveAndroidHelperArtifact,
} from './helper-package-install.ts';

const ANDROID_MULTITOUCH_HELPER_NAME = 'android-multitouch-helper';
const ANDROID_MULTITOUCH_HELPER_PACKAGE = 'com.callstack.agentdevice.multitouchhelper';
const ANDROID_MULTITOUCH_HELPER_RUNNER =
  'com.callstack.agentdevice.multitouchhelper/.MultiTouchInstrumentation';
const ANDROID_MULTITOUCH_HELPER_PROTOCOL = 'android-multitouch-helper-v1';
const ANDROID_MULTITOUCH_HELPER_INSTALL_TIMEOUT_MS = 30_000;
const ANDROID_MULTITOUCH_HELPER_GESTURE_TIMEOUT_MS = 45_000;
const ANDROID_MULTITOUCH_HELPER_DEFAULT_DURATION_MS = 300;
const ANDROID_MULTITOUCH_HELPER_DEFAULT_RADIUS = 160;
const ANDROID_MULTITOUCH_HELPER_ROTATE_MAX_DEGREES_PER_FRAME = 3;
const ANDROID_MULTITOUCH_HELPER_ROTATE_FRAME_INTERVAL_MS = 16;
const ANDROID_MULTITOUCH_HELPER_ROTATE_MAX_DURATION_MS = 2_400;
const ANDROID_MULTITOUCH_HELPER_NO_FINAL_RESULT = 'ANDROID_MULTITOUCH_HELPER_NO_FINAL_RESULT';
const ANDROID_MULTITOUCH_HELPER_REPORTED_FAILURE = 'ANDROID_MULTITOUCH_HELPER_REPORTED_FAILURE';
const HELPER_LABEL = 'Android multi-touch helper';
// readAndroidHelperManifestXxx already prepend "Android " to this label.
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

type AndroidMultiTouchHelperGestureRequest =
  | {
      kind: 'swipe';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      durationMs: number;
    }
  | {
      kind: 'pinch';
      x: number;
      y: number;
      scale: number;
      radius: number;
      durationMs: number;
    }
  | {
      kind: 'rotate';
      x: number;
      y: number;
      degrees: number;
      radius: number;
      durationMs: number;
    }
  | {
      kind: 'transform';
      x: number;
      y: number;
      dx: number;
      dy: number;
      scale: number;
      degrees: number;
      durationMs: number;
    };

export type AndroidPinchGestureOptions = {
  scale: number;
  x?: number;
  y?: number;
  durationMs?: number;
};

export type AndroidRotateGestureOptions = {
  degrees: number;
  x?: number;
  y?: number;
  velocity?: number;
  durationMs?: number;
};

export type AndroidTransformGestureOptions = TransformGestureParams;

export type AndroidSwipeGestureOptions = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  durationMs?: number;
};

export async function swipeGestureAndroid(
  device: DeviceInfo,
  options: AndroidSwipeGestureOptions,
): Promise<Record<string, unknown> | void> {
  const providerResult = await runAndroidTouchProviderGesture(device, {
    kind: 'swipe',
    ...options,
  });
  if (providerResult) return providerResult;

  try {
    return await runAndroidMultiTouchHelperGestureForDevice(device, { kind: 'swipe', ...options });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_swipe_helper_fallback',
      data: {
        error: normalizeError(error).message,
      },
    });
    await swipeAndroid(device, options.x1, options.y1, options.x2, options.y2, options.durationMs);
    return { backend: 'adb-input-swipe-fallback' };
  }
}

export async function pinchAndroid(
  device: DeviceInfo,
  options: AndroidPinchGestureOptions,
): Promise<Record<string, unknown>> {
  if (!Number.isFinite(options.scale) || options.scale <= 0) {
    throw new AppError('INVALID_ARGS', 'gesture pinch requires scale > 0');
  }
  const center = await resolveGestureCenter(device, options.x, options.y);
  return await performAndroidTouchGesture(device, {
    kind: 'pinch',
    x: center.x,
    y: center.y,
    scale: options.scale,
    durationMs: options.durationMs,
  });
}

export async function rotateGestureAndroid(
  device: DeviceInfo,
  options: AndroidRotateGestureOptions,
): Promise<Record<string, unknown>> {
  if (!Number.isFinite(options.degrees)) {
    throw new AppError('INVALID_ARGS', 'gesture rotate requires finite degrees');
  }
  if (
    options.velocity !== undefined &&
    (!Number.isFinite(options.velocity) || options.velocity === 0)
  ) {
    throw new AppError('INVALID_ARGS', 'gesture rotate velocity must be a non-zero number');
  }
  const center = await resolveGestureCenter(device, options.x, options.y);
  const degrees = options.degrees;
  return await performAndroidTouchGesture(device, {
    kind: 'rotate',
    x: center.x,
    y: center.y,
    degrees,
    durationMs: options.durationMs,
  });
}

export async function transformGestureAndroid(
  device: DeviceInfo,
  options: AndroidTransformGestureOptions,
): Promise<Record<string, unknown>> {
  if (!Number.isFinite(options.scale) || options.scale <= 0) {
    throw new AppError('INVALID_ARGS', 'gesture transform requires scale > 0');
  }
  if (!Number.isFinite(options.degrees)) {
    throw new AppError('INVALID_ARGS', 'gesture transform requires finite degrees');
  }
  if (![options.x, options.y, options.dx, options.dy].every(Number.isFinite)) {
    throw new AppError('INVALID_ARGS', 'gesture transform requires finite x y dx dy');
  }
  return await performAndroidTouchGesture(device, {
    kind: 'transform',
    x: options.x,
    y: options.y,
    dx: options.dx,
    dy: options.dy,
    scale: options.scale,
    degrees: options.degrees,
    durationMs: options.durationMs,
  });
}

async function resolveGestureCenter(
  device: DeviceInfo,
  x: number | undefined,
  y: number | undefined,
): Promise<{ x: number; y: number }> {
  if (x !== undefined && y !== undefined) return { x, y };
  const size = await getAndroidScreenSize(device);
  return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
}

async function performAndroidTouchGesture(
  device: DeviceInfo,
  request: AndroidTouchGestureRequest,
): Promise<Record<string, unknown>> {
  const providerResult = await runAndroidTouchProviderGesture(device, request);
  if (providerResult) return providerResult;

  return await runAndroidMultiTouchHelperGestureForDevice(device, request);
}

async function runAndroidTouchProviderGesture(
  device: DeviceInfo,
  request: AndroidTouchGestureRequest,
): Promise<Record<string, unknown> | undefined> {
  const providerTouch = resolveAndroidTouchInjector(device);
  if (!providerTouch) return undefined;
  const result = (await providerTouch(request)) ?? {};
  return { backend: 'provider-native-touch', ...result };
}

async function runAndroidMultiTouchHelperGestureForDevice(
  device: DeviceInfo,
  request: AndroidTouchGestureRequest,
): Promise<Record<string, unknown>> {
  const adb = resolveAndroidAdbExecutor(device);
  const artifact = await resolveAndroidMultiTouchHelperArtifact();
  const adbProvider = resolveAndroidAdbProvider(device);
  const install = await withDiagnosticTimer(
    'android_multitouch_helper_install',
    async () =>
      await ensureAndroidMultiTouchHelper({
        adb,
        adbProvider,
        artifact,
        deviceKey: getAndroidMultiTouchHelperDeviceKey(device),
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
  const output = await withDiagnosticTimer(
    'android_multitouch_helper_gesture',
    async () =>
      await runAndroidMultiTouchHelperGesture({
        adb,
        request: normalizeHelperGestureRequest(request),
        packageName: artifact.manifest.packageName,
        instrumentationRunner: artifact.manifest.instrumentationRunner,
      }),
    {
      packageName: artifact.manifest.packageName,
      version: artifact.manifest.version,
    },
  );
  return {
    backend: 'android-multitouch-helper',
    helperVersion: artifact.manifest.version,
    installReason: install.reason,
    ...output,
  };
}

function normalizeHelperGestureRequest(
  request: AndroidTouchGestureRequest,
): AndroidMultiTouchHelperGestureRequest {
  const durationMs = Math.round(resolveHelperGestureDurationMs(request));
  switch (request.kind) {
    case 'swipe':
      return {
        kind: 'swipe',
        x1: Math.round(request.x1),
        y1: Math.round(request.y1),
        x2: Math.round(request.x2),
        y2: Math.round(request.y2),
        durationMs,
      };
    case 'pinch':
      return {
        kind: 'pinch',
        x: Math.round(request.x),
        y: Math.round(request.y),
        scale: request.scale,
        radius: ANDROID_MULTITOUCH_HELPER_DEFAULT_RADIUS,
        durationMs,
      };
    case 'rotate':
      return {
        kind: 'rotate',
        x: Math.round(request.x),
        y: Math.round(request.y),
        degrees: request.degrees,
        radius: ANDROID_MULTITOUCH_HELPER_DEFAULT_RADIUS,
        durationMs,
      };
    case 'transform':
      return {
        kind: 'transform',
        x: Math.round(request.x),
        y: Math.round(request.y),
        dx: Math.round(request.dx),
        dy: Math.round(request.dy),
        scale: request.scale,
        degrees: request.degrees,
        durationMs,
      };
  }
}

function resolveHelperGestureDurationMs(request: AndroidTouchGestureRequest): number {
  if (request.durationMs !== undefined) {
    return request.durationMs;
  }
  if (request.kind === 'swipe' || request.kind === 'pinch') {
    return ANDROID_MULTITOUCH_HELPER_DEFAULT_DURATION_MS;
  }
  const angleBasedDuration =
    Math.ceil(Math.abs(request.degrees) / ANDROID_MULTITOUCH_HELPER_ROTATE_MAX_DEGREES_PER_FRAME) *
    ANDROID_MULTITOUCH_HELPER_ROTATE_FRAME_INTERVAL_MS;
  return Math.min(
    Math.max(ANDROID_MULTITOUCH_HELPER_DEFAULT_DURATION_MS, angleBasedDuration),
    ANDROID_MULTITOUCH_HELPER_ROTATE_MAX_DURATION_MS,
  );
}

export async function runAndroidMultiTouchHelperGesture(options: {
  adb: AndroidAdbExecutor;
  request: AndroidMultiTouchHelperGestureRequest;
  packageName: string;
  instrumentationRunner: string;
}): Promise<Record<string, unknown>> {
  const payloadBase64 = Buffer.from(
    JSON.stringify({
      protocol: ANDROID_MULTITOUCH_HELPER_PROTOCOL,
      ...options.request,
    }),
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
    { allowFailure: true, timeoutMs: ANDROID_MULTITOUCH_HELPER_GESTURE_TIMEOUT_MS },
  );
  let output: Record<string, unknown>;
  try {
    output = parseAndroidMultiTouchHelperOutput(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === ANDROID_MULTITOUCH_HELPER_REPORTED_FAILURE) {
        throw new AppError('COMMAND_FAILED', error.message, error.details, error);
      }
      if (error.code !== ANDROID_MULTITOUCH_HELPER_NO_FINAL_RESULT) {
        throw error;
      }
    }
    // exec-guard-allow: reachable at exit 0 (helper output unparseable); the
    // message already branches on the exit code.
    throw new AppError(
      'COMMAND_FAILED',
      result.exitCode === 0
        ? 'Android multi-touch helper output could not be parsed'
        : 'Android multi-touch helper failed before returning parseable output',
      {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
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
    (record) => record.agentDeviceProtocol === ANDROID_MULTITOUCH_HELPER_PROTOCOL,
  );
  if (!finalResult) {
    throw new AppError(
      ANDROID_MULTITOUCH_HELPER_NO_FINAL_RESULT,
      'Android multi-touch helper did not return a final result',
    );
  }
  if (finalResult.ok !== 'true') {
    throw new AppError(
      ANDROID_MULTITOUCH_HELPER_REPORTED_FAILURE,
      readHelperErrorMessage(finalResult),
      {
        errorType: finalResult.errorType,
        helper: finalResult,
      },
    );
  }
  return {
    kind: finalResult.kind,
    helperApiVersion: finalResult.helperApiVersion,
    injectedEvents: readInstrumentationResultNumber(finalResult.injectedEvents),
    elapsedMs: readInstrumentationResultNumber(finalResult.elapsedMs),
  };
}

function readHelperErrorMessage(finalResult: Record<string, string>): string {
  return finalResult.message && finalResult.message !== 'null'
    ? finalResult.message
    : finalResult.errorType || 'Android multi-touch helper returned an error';
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
    name: readAndroidHelperManifestLiteral(
      record.name,
      'name',
      ANDROID_MULTITOUCH_HELPER_NAME,
      MANIFEST_HELPER_LABEL,
    ),
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
      ANDROID_MULTITOUCH_HELPER_PACKAGE,
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
      ANDROID_MULTITOUCH_HELPER_RUNNER,
      MANIFEST_HELPER_LABEL,
    ),
    statusProtocol: readAndroidHelperManifestLiteral(
      record.statusProtocol,
      'statusProtocol',
      ANDROID_MULTITOUCH_HELPER_PROTOCOL,
      MANIFEST_HELPER_LABEL,
    ),
  };
}

const installedMultiTouchHelpers = new Set<string>();

export const ensureAndroidMultiTouchHelper =
  makeEnsureAndroidHelperInstalled<AndroidMultiTouchHelperArtifact>({
    cache: installedMultiTouchHelpers,
    installTimeoutMs: ANDROID_MULTITOUCH_HELPER_INSTALL_TIMEOUT_MS,
    helperLabel: HELPER_LABEL,
  });

// Tests reset the process-global install memo so cases do not share helper state.
export function resetAndroidMultiTouchHelperInstallCache(): void {
  installedMultiTouchHelpers.clear();
}

function getAndroidMultiTouchHelperDeviceKey(device: DeviceInfo): string {
  return `${device.platform}:${device.id}`;
}
