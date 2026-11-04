import path from 'node:path';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import type { ScreenshotScreenMask } from '@agent-device/contracts/capture';
import { assertScreenshotCaptureSupport } from '@agent-device/contracts/screenshot-runtime';
import { appleScreenshotCaptureCapabilities } from '../screenshot-support.ts';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { copyHostFile } from '@agent-device/host-kit/host-file';
import { copySimulatorFileToHost } from './simulator-files.ts';
import { resolveAppleToolProvider } from './tool-provider.ts';
import { Deadline, retryWithPolicy } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import {
  readRunnerScreenCaptureMetadata,
  type RunnerScreenCaptureMetadata,
} from '@agent-device/contracts/screen-capture-contract';
import type { ScreenshotCaptureFacts } from '@agent-device/contracts/interactor-types';

import { resizePngFile } from '@agent-device/capture-kit/png-resize';
import { readPngSize } from '@agent-device/capture-kit/png-size';
import { computeDensityScaledScreenshotSize } from '@agent-device/capture-kit/screenshot-density';
import {
  IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS,
  IOS_SIMULATOR_SCREENSHOT_RETRY_BASE_DELAY_MS,
  IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_ATTEMPTS,
  IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_DELAY_MS,
  IOS_SIMULATOR_SCREENSHOT_SCALE_TIMEOUT_MS,
  IOS_SIMULATOR_SCREENSHOT_TIMEOUT_MS,
} from './config.ts';
import { runAppleRunnerCommand } from './runner-client.ts';
import {
  resolveRunnerContainerBundleIds,
  type AppleRunnerCommandOptions,
} from '@agent-device/apple-runner';
import {
  withNormalizedSimulatorStatusBar,
  withSimulatorStatusBarHeld,
} from './screenshot-status-bar.ts';
import {
  appleSimulatorDisplayArgvFragment,
  resolveAppleCaptureTarget,
  type AppleCaptureTarget,
  type AppleDeviceDisplay,
} from './display-inventory.ts';
import { ensureBootedSimulator } from './simulator.ts';
import { runSimctlForDevice } from './simctl-execution.ts';
import { appleToolFailureText, extractAppleToolErrorMeta } from './tool-diagnostics.ts';
import { resolveIosPhysicalDeviceControl } from './physical-device-control.ts';

type SimulatorScreenshotFlowDeps = {
  ensureBooted: (device: DeviceInfo) => Promise<void>;
  /**
   * Runs `capture` while it owns the simulator's status bar: normalized to the deterministic state,
   * with the caller's overrides restored afterwards. One capture per simulator at a time.
   */
  withNormalizedStatusBar: <T>(
    device: DeviceInfo,
    capture: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  /**
   * Runs `capture` while it owns the simulator's status bar, without changing the bar. It still
   * waits: a capture that normalizes shows the deterministic state while it is in flight.
   */
  withStatusBarHeld: <T>(
    device: DeviceInfo,
    capture: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  resolveCaptureTarget: (device: DeviceInfo) => Promise<AppleCaptureTarget>;
  captureWithRetry: (
    device: DeviceInfo,
    outPath: string,
    screenMask: ScreenshotScreenMask | undefined,
    display: AppleDeviceDisplay | undefined,
  ) => Promise<void>;
  /**
   * Rescales the captured file to the requested density using the scale of the image that was
   * actually taken. `sourcePixelDensity` is that image's own measured scale — the panel the host
   * named for a `simctl` capture, or what the runner reported for a runner capture. Undefined means
   * nobody measured the source: a single-panel `simctl` capture, or a multi-panel device whose
   * display inventory never resolved, and the scale probe is the answer either way.
   */
  normalizeDensity: (
    device: DeviceInfo,
    outPath: string,
    pixelDensity: number | undefined,
    sourcePixelDensity: number | undefined,
  ) => Promise<void>;
  captureWithRunner: (
    device: DeviceInfo,
    outPath: string,
    appBundleId: string | undefined,
    fullscreen: boolean | undefined,
    runnerOptions: AppleRunnerCommandOptions | undefined,
    env: Readonly<EnvMap>,
  ) => Promise<RunnerScreenCaptureMetadata | undefined>;
  shouldFallbackToRunner: (error: unknown) => boolean;
};

type SimulatorScreenshotFlowOptions = {
  /** The calling runtime's host environment; runner-container configuration is read from it. */
  env: Readonly<EnvMap>;
  appBundleId?: string;
  fullscreen?: boolean;
  pixelDensity?: number;
  screenMask?: ScreenshotScreenMask;
  normalizeStatusBar?: boolean;
  runnerOptions?: AppleRunnerCommandOptions;
  skipIosSimulatorBootCheck?: boolean;
  deps?: Partial<SimulatorScreenshotFlowDeps>;
};

const defaultSimulatorScreenshotFlowDeps: SimulatorScreenshotFlowDeps = {
  ensureBooted: ensureBootedSimulator,
  withNormalizedStatusBar: withNormalizedSimulatorStatusBar,
  withStatusBarHeld: withSimulatorStatusBarHeld,
  resolveCaptureTarget: resolveAppleCaptureTarget,
  captureWithRetry: captureSimulatorScreenshotWithRetry,
  normalizeDensity: normalizeIosSimulatorScreenshotDensity,
  captureWithRunner: captureScreenshotViaRunner,
  shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
};

const iosSimulatorMainScreenScaleCache = new Map<string, number>();
const iosSimulatorRunnerBundleCache = new Map<string, string>();

export async function screenshotIos(
  device: DeviceInfo,
  outPath: string,
  options: Omit<SimulatorScreenshotFlowOptions, 'deps'>,
): Promise<ScreenshotCaptureFacts> {
  await assertScreenshotCaptureSupport(options, appleScreenshotCaptureCapabilities(device, {}));
  if (isMacOs(device)) {
    await captureScreenshotViaRunner(
      device,
      outPath,
      options.appBundleId,
      options.fullscreen,
      options.runnerOptions,
      options.env,
    );
    return {};
  }
  if (device.kind === 'simulator') {
    return await captureSimulatorScreenshotWithFallback(device, outPath, options);
  }

  return await resolveIosPhysicalDeviceControl(device).captureScreenshot(device, outPath, {
    appBundleId: options.appBundleId,
    fullscreen: options.fullscreen,
    runnerOptions: options.runnerOptions,
    runRunnerCommand: runAppleRunnerCommand,
    env: options.env,
  });
}

export async function captureSimulatorScreenshotWithFallback(
  device: DeviceInfo,
  outPath: string,
  options: SimulatorScreenshotFlowOptions,
): Promise<ScreenshotCaptureFacts> {
  await assertScreenshotCaptureSupport(options, appleScreenshotCaptureCapabilities(device, {}));
  if (device.kind !== 'simulator') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Simulator screenshot fallback flow supports only iOS simulators',
    );
  }

  const deps = { ...defaultSimulatorScreenshotFlowDeps, ...(options.deps ?? {}) };

  if (!options.skipIosSimulatorBootCheck) {
    await deps.ensureBooted(device);
  }
  // A foldable lights one panel at a time, so the capture must name the panel the
  // system is currently showing rather than accept simctl's implicit default.
  const { display, displayRotation } = await deps.resolveCaptureTarget(device);
  const captureFacts: ScreenshotCaptureFacts = displayRotation ? { displayRotation } : {};
  const captureAndNormalize = async () => {
    await deps.captureWithRetry(device, outPath, options.screenMask, display);
    await deps.normalizeDensity(device, outPath, options.pixelDensity, display?.pointScale);
  };
  const captureWithFallback = async (): Promise<ScreenshotCaptureFacts> => {
    if (resolveAppleToolProvider().simulatorScreenshotBackend !== 'runner') {
      try {
        await captureAndNormalize();
        return captureFacts;
      } catch (error) {
        let screenshotError = error;
        if (
          options.skipIosSimulatorBootCheck &&
          shouldEnsureBootedAfterSimulatorScreenshotFailure(error)
        ) {
          await deps.ensureBooted(device);
          try {
            await captureAndNormalize();
            return captureFacts;
          } catch (retryError) {
            screenshotError = retryError;
          }
        }
        if (options.screenMask !== undefined || !deps.shouldFallbackToRunner(screenshotError)) {
          throw screenshotError;
        }
        emitScreenshotFallbackDiagnostic(device, 'simctl_screenshot', screenshotError);
      }
    }
    const captured = await deps.captureWithRunner(
      device,
      outPath,
      options.appBundleId,
      options.fullscreen,
      options.runnerOptions,
      options.env,
    );
    // The runner captures the display that actually hosts the app and reports the scale it encoded
    // that image at, so normalization reads the source instead of applying a panel the host guessed.
    // A runner that reports nothing measured nothing: the probe stays the pre-panel answer rather
    // than borrowing a scale from a panel nobody captured (#2728).
    await deps.normalizeDensity(device, outPath, options.pixelDensity, captured?.pixelsPerPoint);
    return captureFacts;
  };

  const holdStatusBar =
    options.normalizeStatusBar === true ? deps.withNormalizedStatusBar : deps.withStatusBarHeld;
  return await holdStatusBar(device, captureWithFallback, options.runnerOptions?.signal);
}

export async function captureSimulatorScreenshotWithRetry(
  device: DeviceInfo,
  outPath: string,
  screenMask: ScreenshotScreenMask | undefined,
  display?: AppleDeviceDisplay,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(IOS_SIMULATOR_SCREENSHOT_TIMEOUT_MS);
  const argv = [
    'io',
    device.id,
    'screenshot',
    ...(screenMask === 'black' ? ['--mask=black'] : []),
    ...appleSimulatorDisplayArgvFragment(display),
    outPath,
  ];
  await retryWithPolicy(
    async ({ deadline: attemptDeadline }) => {
      await runSimctlForDevice(device, argv, {
        timeoutMs: Math.max(
          1_000,
          attemptDeadline?.remainingMs() ?? IOS_SIMULATOR_SCREENSHOT_TIMEOUT_MS,
        ),
      });
    },
    {
      maxAttempts: IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_ATTEMPTS,
      baseDelayMs: IOS_SIMULATOR_SCREENSHOT_RETRY_BASE_DELAY_MS,
      maxDelayMs: IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_DELAY_MS,
      jitter: 0.2,
      shouldRetry: (error) => shouldRetryIosSimulatorScreenshot(error),
    },
    { deadline, phase: 'ios_simulator_screenshot' },
  );
}

/** The runner renders this target's screen the way `simctl io screenshot` does, through the simulator. */
function capturesThroughSimulatorStatusBar(device: DeviceInfo): boolean {
  return device.kind === 'simulator' && !isMacOs(device);
}

/** The runner reaches this target through the physical-device control rather than the runner app. */
function capturesThroughPhysicalDeviceControl(device: DeviceInfo): boolean {
  return device.kind === 'device' && !isMacOs(device);
}

/**
 * Captures through the runner backend. An iOS simulator's runner capture renders the same screen a
 * simctl capture does, so it takes the same status bar reservation: while another capture
 * normalizes the bar, this one would otherwise copy an image of the temporary 9:41 overrides. This
 * reservation covers the runner capture alone; the density normalization the fallback flow applies
 * afterwards is covered by that flow's own hold, and a direct call here performs no density step.
 * It re-enters when the caller already holds it, as the simctl fallback does, and an already-aborted
 * request does not reject that re-entry at the lock boundary — see `withSimulatorStatusBarHeld`. The
 * runner command keeps the request's signal.
 */
export async function captureScreenshotViaRunner(
  device: DeviceInfo,
  outPath: string,
  appBundleId: string | undefined,
  requestedFullscreen: boolean | undefined,
  runnerOptions: AppleRunnerCommandOptions | undefined,
  env: Readonly<EnvMap>,
): Promise<RunnerScreenCaptureMetadata | undefined> {
  const fullscreen =
    requestedFullscreen ??
    (device.kind === 'simulator' &&
    resolveAppleToolProvider().simulatorScreenshotBackend === 'runner'
      ? true
      : undefined);
  if (!capturesThroughSimulatorStatusBar(device)) {
    return await captureRunnerScreenshot(
      device,
      outPath,
      appBundleId,
      fullscreen,
      runnerOptions,
      env,
    );
  }
  return await withSimulatorStatusBarHeld(
    device,
    async () =>
      await captureRunnerScreenshot(device, outPath, appBundleId, fullscreen, runnerOptions, env),
    runnerOptions?.signal,
  );
}

async function captureRunnerScreenshot(
  device: DeviceInfo,
  outPath: string,
  appBundleId: string | undefined,
  fullscreen: boolean | undefined,
  runnerOptions: AppleRunnerCommandOptions | undefined,
  env: Readonly<EnvMap>,
): Promise<RunnerScreenCaptureMetadata | undefined> {
  if (capturesThroughPhysicalDeviceControl(device)) {
    await resolveIosPhysicalDeviceControl(device).captureScreenshot(device, outPath, {
      appBundleId,
      fullscreen,
      runnerOptions,
      preferRunner: true,
      runRunnerCommand: runAppleRunnerCommand,
      env,
    });
    return undefined;
  }

  const result = await runAppleRunnerCommand(
    device,
    {
      command: 'screenshot',
      appBundleId,
      fullscreen,
      inlineScreenshot: false,
    },
    runnerOptions,
  );
  const remoteFileName = result['message'] as string;
  if (!remoteFileName) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to capture iOS screenshot: runner returned no file path',
    );
  }

  const metadata = readRunnerScreenCaptureMetadata(result);
  if (isMacOs(device)) {
    await copyHostFile(remoteFileName, outPath);
    return metadata;
  }

  if (device.kind === 'simulator') {
    await copyRunnerScreenshotFromSimulator(
      device,
      remoteFileName,
      outPath,
      env,
      runnerOptions?.signal,
    );
    return metadata;
  }
  throw new AppError('COMMAND_FAILED', 'Unsupported Apple screenshot target');
}

async function copyRunnerScreenshotFromSimulator(
  device: DeviceInfo,
  remoteFileName: string,
  outPath: string,
  env: Readonly<EnvMap>,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS);
  let lastError = 'Unable to locate runner container for simulator screenshot';
  const cachedBundleId = iosSimulatorRunnerBundleCache.get(device.id);
  const bundleIds = resolveRunnerContainerBundleIds(env);
  if (cachedBundleId) bundleIds.unshift(cachedBundleId);
  for (const bundleId of new Set(bundleIds)) {
    for (const sourcePath of resolveRunnerScreenshotFilePaths(remoteFileName)) {
      try {
        await copySimulatorFileToHost({
          device,
          bundleId,
          containerType: 'data',
          signal,
          sourcePath,
          destinationPath: outPath,
          timeoutMs: resolveDeadlineTimeoutMs(
            deadline,
            IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS,
            'runner screenshot copy',
          ),
        });
        iosSimulatorRunnerBundleCache.set(device.id, bundleId);
        return;
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  iosSimulatorRunnerBundleCache.delete(device.id);
  throw new AppError('COMMAND_FAILED', `Failed to capture iOS screenshot: ${lastError}`);
}

export function resolveRunnerScreenshotFilePaths(remoteFileName: string): string[] {
  const rawPath = remoteFileName.trim();
  if (!rawPath) return [];
  const paths = new Set([rawPath]);
  const posixPath = rawPath.replaceAll('\\', '/');
  const tmpIndex = posixPath.lastIndexOf('/tmp/');
  if (tmpIndex >= 0) paths.add(posixPath.slice(tmpIndex + 1));
  paths.add(`tmp/${path.posix.basename(posixPath)}`);
  return [...paths];
}

function resolveDeadlineTimeoutMs(deadline: Deadline, timeoutMs: number, step: string): number {
  const remainingMs = deadline.remainingMs();
  if (remainingMs > 0) return remainingMs;
  throw new AppError('COMMAND_FAILED', `iOS ${step} timed out after ${timeoutMs}ms`, {
    timeoutMs,
    step,
  });
}

function emitScreenshotFallbackDiagnostic(
  device: DeviceInfo,
  from: 'simctl_screenshot',
  error: unknown,
): void {
  const errorMeta = extractAppleToolErrorMeta(error);
  emitDiagnostic({
    level: 'warn',
    phase: 'ios_screenshot_fallback',
    data: {
      platform: device.platform,
      deviceKind: device.kind,
      deviceId: device.id,
      from,
      to: 'runner',
      ...errorMeta,
    },
  });
}

export function shouldRetryIosSimulatorScreenshot(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code !== 'COMMAND_FAILED') return false;
  const combined = appleToolFailureText(error);
  return (
    combined.includes('timeout waiting for screen surfaces') ||
    (combined.includes('nsposixerrordomain') &&
      combined.includes('code=60') &&
      combined.includes('screenshot')) ||
    (combined.includes('timed out') && combined.includes('screenshot'))
  );
}

function shouldEnsureBootedAfterSimulatorScreenshotFailure(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code !== 'COMMAND_FAILED') return false;
  const combined = appleToolFailureText(error);
  return (
    combined.includes('not booted') ||
    combined.includes('current state: shutdown') ||
    combined.includes('current state is shutdown') ||
    combined.includes('current state=shutdown') ||
    combined.includes('state: shutdown') ||
    combined.includes('state=shutdown')
  );
}

async function normalizeIosSimulatorScreenshotDensity(
  device: DeviceInfo,
  outPath: string,
  pixelDensity: number | undefined,
  sourcePixelDensity?: number,
): Promise<void> {
  // Both the captured panel's `pointScale` and the runner's reported scale describe the image that
  // was actually taken. `SIMULATOR_MAINSCREEN_SCALE` describes one fixed panel, so on a foldable it
  // can disagree with the panel that was captured, and it is only ever consulted when nothing
  // measured the source — which a multi-panel capture and every runner capture do.
  const measuredSourcePixelDensity =
    sourcePixelDensity ?? (await readIosSimulatorMainScreenScale(device));
  const targetSize = computeDensityScaledScreenshotSize(
    await readPngSize(outPath),
    measuredSourcePixelDensity,
    pixelDensity,
  );
  if (targetSize) await resizePngFile(outPath, targetSize.width, targetSize.height);
}

async function readIosSimulatorMainScreenScale(device: DeviceInfo): Promise<number> {
  const cachedScale = iosSimulatorMainScreenScaleCache.get(device.id);
  if (cachedScale !== undefined) {
    return cachedScale;
  }
  const scaleResult = await runSimctlForDevice(
    device,
    ['getenv', device.id, 'SIMULATOR_MAINSCREEN_SCALE'],
    {
      timeoutMs: IOS_SIMULATOR_SCREENSHOT_SCALE_TIMEOUT_MS,
    },
  );
  const scale = Number(scaleResult.stdout.trim());
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to read iOS simulator screenshot scale from SIMULATOR_MAINSCREEN_SCALE',
    );
  }
  iosSimulatorMainScreenScaleCache.set(device.id, scale);
  return scale;
}
