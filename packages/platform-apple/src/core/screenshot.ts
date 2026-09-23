import path from 'node:path';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { copyHostFile } from '@agent-device/host-kit/host-file';
import { Deadline, retryWithPolicy } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import {
  readRunnerScreenCaptureMetadata,
  type RunnerScreenCaptureMetadata,
} from '@agent-device/contracts/screen-capture-contract';

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
  IOS_RUNNER_CONTAINER_BUNDLE_IDS,
  type AppleRunnerCommandOptions,
} from '../runner/index.ts';
import { prepareSimulatorStatusBarForScreenshot } from './screenshot-status-bar.ts';
import {
  appleSimulatorDisplayArgvFragment,
  resolveAppleCaptureDisplay,
  type AppleDeviceDisplay,
} from './display-inventory.ts';
import { ensureBootedSimulator } from './simulator.ts';
import { runSimctlForDevice } from './simctl.ts';
import { appleToolFailureText, extractAppleToolErrorMeta } from './tool-diagnostics.ts';
import { resolveIosPhysicalDeviceControl } from './physical-device-control.ts';

type SimulatorScreenshotFlowDeps = {
  ensureBooted: (device: DeviceInfo) => Promise<void>;
  prepareStatusBarForScreenshot: (device: DeviceInfo) => Promise<() => Promise<void>>;
  resolveCaptureDisplay: (device: DeviceInfo) => Promise<AppleDeviceDisplay | undefined>;
  captureWithRetry: (
    device: DeviceInfo,
    outPath: string,
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
    appBundleId?: string,
    fullscreen?: boolean,
    runnerOptions?: AppleRunnerCommandOptions,
  ) => Promise<RunnerScreenCaptureMetadata | undefined>;
  shouldFallbackToRunner: (error: unknown) => boolean;
};

type SimulatorScreenshotFlowOptions = {
  appBundleId?: string;
  fullscreen?: boolean;
  pixelDensity?: number;
  normalizeStatusBar?: boolean;
  runnerOptions?: AppleRunnerCommandOptions;
  skipIosSimulatorBootCheck?: boolean;
  deps?: Partial<SimulatorScreenshotFlowDeps>;
};

const defaultSimulatorScreenshotFlowDeps: SimulatorScreenshotFlowDeps = {
  ensureBooted: ensureBootedSimulator,
  prepareStatusBarForScreenshot: prepareSimulatorStatusBarForScreenshot,
  resolveCaptureDisplay: resolveAppleCaptureDisplay,
  captureWithRetry: captureSimulatorScreenshotWithRetry,
  normalizeDensity: normalizeIosSimulatorScreenshotDensity,
  captureWithRunner: captureScreenshotViaRunner,
  shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
};

const iosSimulatorMainScreenScaleCache = new Map<string, number>();
const iosSimulatorRunnerContainerCache = new Map<string, string>();

export async function screenshotIos(
  device: DeviceInfo,
  outPath: string,
  options: Omit<SimulatorScreenshotFlowOptions, 'deps'> = {},
): Promise<void> {
  if (isMacOs(device)) {
    await captureScreenshotViaRunner(
      device,
      outPath,
      options.appBundleId,
      options.fullscreen,
      options.runnerOptions,
    );
    return;
  }
  if (device.kind === 'simulator') {
    await captureSimulatorScreenshotWithFallback(device, outPath, options);
    return;
  }

  await resolveIosPhysicalDeviceControl(device).captureScreenshot(device, outPath, {
    appBundleId: options.appBundleId,
    fullscreen: options.fullscreen,
    runnerOptions: options.runnerOptions,
    runRunnerCommand: runAppleRunnerCommand,
  });
}

export async function captureSimulatorScreenshotWithFallback(
  device: DeviceInfo,
  outPath: string,
  options: SimulatorScreenshotFlowOptions = {},
): Promise<void> {
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
  const display = await deps.resolveCaptureDisplay(device);
  const captureAndNormalize = async () => {
    await deps.captureWithRetry(device, outPath, display);
    await deps.normalizeDensity(device, outPath, options.pixelDensity, display?.pointScale);
  };
  let restoreStatusBar = async () => {};
  if (options.normalizeStatusBar === true) {
    try {
      restoreStatusBar = await deps.prepareStatusBarForScreenshot(device);
    } catch (error) {
      emitStatusBarDiagnostic(device, 'prepare_failed', error);
    }
  }
  try {
    try {
      await captureAndNormalize();
      return;
    } catch (error) {
      let screenshotError = error;
      if (
        options.skipIosSimulatorBootCheck &&
        shouldEnsureBootedAfterSimulatorScreenshotFailure(error)
      ) {
        await deps.ensureBooted(device);
        try {
          await captureAndNormalize();
          return;
        } catch (retryError) {
          screenshotError = retryError;
        }
      }
      if (!deps.shouldFallbackToRunner(screenshotError)) {
        throw screenshotError;
      }
      emitScreenshotFallbackDiagnostic(device, 'simctl_screenshot', screenshotError);
    }
    const captured = await deps.captureWithRunner(
      device,
      outPath,
      options.appBundleId,
      options.fullscreen,
      options.runnerOptions,
    );
    // The runner captures the display that actually hosts the app and reports the scale it encoded
    // that image at, so normalization reads the source instead of applying a panel the host guessed.
    // A runner that reports nothing measured nothing: the probe stays the pre-panel answer rather
    // than borrowing a scale from a panel nobody captured (#2728).
    await deps.normalizeDensity(device, outPath, options.pixelDensity, captured?.pixelsPerPoint);
  } finally {
    await restoreStatusBar().catch((error) =>
      emitStatusBarDiagnostic(device, 'restore_failed', error),
    );
  }
}

export async function captureSimulatorScreenshotWithRetry(
  device: DeviceInfo,
  outPath: string,
  display?: AppleDeviceDisplay,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(IOS_SIMULATOR_SCREENSHOT_TIMEOUT_MS);
  const argv = [
    'io',
    device.id,
    'screenshot',
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

export async function captureScreenshotViaRunner(
  device: DeviceInfo,
  outPath: string,
  appBundleId?: string,
  fullscreen?: boolean,
  runnerOptions?: AppleRunnerCommandOptions,
): Promise<RunnerScreenCaptureMetadata | undefined> {
  if (device.kind === 'device' && !isMacOs(device)) {
    await resolveIosPhysicalDeviceControl(device).captureScreenshot(device, outPath, {
      appBundleId,
      fullscreen,
      runnerOptions,
      preferRunner: true,
      runRunnerCommand: runAppleRunnerCommand,
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
    await copyRunnerScreenshotFromSimulator(device, remoteFileName, outPath);
    return metadata;
  }
  throw new AppError('COMMAND_FAILED', 'Unsupported Apple screenshot target');
}

async function copyRunnerScreenshotFromSimulator(
  device: DeviceInfo,
  remoteFileName: string,
  outPath: string,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS);
  let lastError = 'Unable to locate runner container for simulator screenshot';
  const cachedContainerPath = iosSimulatorRunnerContainerCache.get(device.id);
  if (cachedContainerPath) {
    const cachedCopy = await tryCopySimulatorRunnerScreenshot(
      cachedContainerPath,
      remoteFileName,
      outPath,
    );
    if (cachedCopy.copied) return;
    lastError = cachedCopy.error;
    iosSimulatorRunnerContainerCache.delete(device.id);
  }
  for (const bundleId of IOS_RUNNER_CONTAINER_BUNDLE_IDS) {
    const containerResult = await runSimctlForDevice(
      device,
      ['get_app_container', device.id, bundleId, 'data'],
      {
        allowFailure: true,
        timeoutMs: resolveDeadlineTimeoutMs(
          deadline,
          IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS,
          'runner screenshot container lookup',
        ),
      },
    );
    if (containerResult.exitCode !== 0) {
      const stderr = containerResult.stderr.trim();
      if (stderr) {
        lastError = stderr;
      }
      continue;
    }
    const containerPath = containerResult.stdout.trim();
    if (!containerPath) {
      lastError = 'simctl get_app_container returned empty output';
      continue;
    }
    const copy = await tryCopySimulatorRunnerScreenshot(containerPath, remoteFileName, outPath);
    if (copy.copied) {
      iosSimulatorRunnerContainerCache.set(device.id, containerPath);
      return;
    }
    lastError = copy.error;
  }
  throw new AppError('COMMAND_FAILED', `Failed to capture iOS screenshot: ${lastError}`);
}

async function tryCopySimulatorRunnerScreenshot(
  containerPath: string,
  remoteFileName: string,
  outPath: string,
): Promise<{ copied: true } | { copied: false; error: string }> {
  let lastError = 'Runner screenshot was not found in the simulator container';
  for (const sourcePath of resolveSimulatorRunnerScreenshotCandidatePaths(
    containerPath,
    remoteFileName,
  )) {
    try {
      await copyHostFile(sourcePath, outPath);
      return { copied: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { copied: false, error: lastError };
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

function emitStatusBarDiagnostic(
  device: DeviceInfo,
  phase: 'prepare_failed' | 'restore_failed',
  error: unknown,
): void {
  emitDiagnostic({
    level: 'warn',
    phase: `ios_screenshot_status_bar_${phase}`,
    data: {
      platform: device.platform,
      deviceKind: device.kind,
      deviceId: device.id,
      ...extractAppleToolErrorMeta(error),
    },
  });
}

export function resolveSimulatorRunnerScreenshotCandidatePaths(
  containerPath: string,
  remoteFileName: string,
): string[] {
  const normalizedContainerPath = path.resolve(containerPath);
  const rawRemotePath = remoteFileName.trim();
  if (!rawRemotePath) return [];

  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (candidate: string) => {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  const relativeFromRoot = rawRemotePath.replace(/^\/+/, '');
  const remotePosixPath = relativeFromRoot.replaceAll('\\', '/');
  if (relativeFromRoot) {
    pushUnique(path.join(normalizedContainerPath, relativeFromRoot));
  }

  if (path.isAbsolute(rawRemotePath)) {
    pushUnique(path.normalize(rawRemotePath));
  }

  if (remotePosixPath.startsWith('tmp/')) {
    pushUnique(path.join(normalizedContainerPath, remotePosixPath));
  } else {
    const tmpSegmentIndex = remotePosixPath.lastIndexOf('/tmp/');
    if (tmpSegmentIndex >= 0) {
      const fromTmp = remotePosixPath.slice(tmpSegmentIndex + 1);
      pushUnique(path.join(normalizedContainerPath, fromTmp));
    }
  }

  const baseName = path.basename(rawRemotePath);
  if (baseName) {
    pushUnique(path.join(normalizedContainerPath, 'tmp', baseName));
  }

  return candidates;
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
