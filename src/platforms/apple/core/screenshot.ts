import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isMacOs, type DeviceInfo } from '../../../kernel/device.ts';
import { emitDiagnostic } from '../../../utils/diagnostics.ts';
import { AppError } from '../../../kernel/errors.ts';
import type { ExecOptions } from '../../../utils/exec.ts';
import { resizePngFile } from '../../../utils/png-resize.ts';
import { readPngSize } from '../../../utils/png-size.ts';
import { computeDensityScaledScreenshotSize } from '../../../utils/screenshot-density.ts';
import { Deadline, retryWithPolicy } from '../../../utils/retry.ts';

import {
  IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS,
  IOS_SIMULATOR_SCREENSHOT_RETRY_BASE_DELAY_MS,
  IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_ATTEMPTS,
  IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_DELAY_MS,
  IOS_SIMULATOR_SCREENSHOT_TIMEOUT_MS,
} from './config.ts';
import { runIosDevicectl } from './devicectl.ts';
import { runAppleRunnerCommand, IOS_RUNNER_CONTAINER_BUNDLE_IDS } from './runner/runner-client.ts';
import type { AppleRunnerCommandOptions } from './runner/runner-provider.ts';
import { prepareSimulatorStatusBarForScreenshot } from './screenshot-status-bar.ts';
import { ensureBootedSimulator } from './simulator.ts';
import { runSimctlForDevice } from './simctl.ts';
import { extractAppleToolErrorMeta } from './tool-diagnostics.ts';
import { runXcrun } from './tool-provider.ts';

function runSimctl(device: DeviceInfo, args: string[], options?: ExecOptions) {
  return runSimctlForDevice(device, args, options);
}

type SimulatorScreenshotFlowDeps = {
  ensureBooted: (device: DeviceInfo) => Promise<void>;
  prepareStatusBarForScreenshot: (device: DeviceInfo) => Promise<() => Promise<void>>;
  captureWithRetry: (device: DeviceInfo, outPath: string) => Promise<void>;
  normalizeDensity: (
    device: DeviceInfo,
    outPath: string,
    pixelDensity: number | undefined,
  ) => Promise<void>;
  captureWithRunner: (
    device: DeviceInfo,
    outPath: string,
    appBundleId?: string,
    fullscreen?: boolean,
    runnerOptions?: AppleRunnerCommandOptions,
  ) => Promise<void>;
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
  captureWithRetry: captureSimulatorScreenshotWithRetry,
  normalizeDensity: normalizeIosSimulatorScreenshotDensity,
  captureWithRunner: captureScreenshotViaRunner,
  shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
};

const iosSimulatorMainScreenScaleCache = new Map<string, number>();

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

  try {
    await runIosDevicectl(['device', 'screenshot', '--device', device.id, outPath], {
      action: 'capture iOS screenshot',
      deviceId: device.id,
    });
    return;
  } catch (error) {
    if (!shouldFallbackToRunnerForIosScreenshot(error)) {
      throw error;
    }
    emitScreenshotFallbackDiagnostic(device, 'devicectl_screenshot', error);
  }

  await captureScreenshotViaRunner(
    device,
    outPath,
    options.appBundleId,
    options.fullscreen,
    options.runnerOptions,
  );
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
      await deps.captureWithRetry(device, outPath);
      await deps.normalizeDensity(device, outPath, options.pixelDensity);
      return;
    } catch (error) {
      let screenshotError = error;
      if (
        options.skipIosSimulatorBootCheck &&
        shouldEnsureBootedAfterSimulatorScreenshotFailure(error)
      ) {
        await deps.ensureBooted(device);
        try {
          await deps.captureWithRetry(device, outPath);
          await deps.normalizeDensity(device, outPath, options.pixelDensity);
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
    await deps.captureWithRunner(
      device,
      outPath,
      options.appBundleId,
      options.fullscreen,
      options.runnerOptions,
    );
    await deps.normalizeDensity(device, outPath, options.pixelDensity);
  } finally {
    await restoreStatusBar().catch((error) =>
      emitStatusBarDiagnostic(device, 'restore_failed', error),
    );
  }
}

export async function captureSimulatorScreenshotWithRetry(
  device: DeviceInfo,
  outPath: string,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(IOS_SIMULATOR_SCREENSHOT_TIMEOUT_MS);
  await retryWithPolicy(
    async ({ deadline: attemptDeadline }) => {
      await runSimctl(device, ['io', device.id, 'screenshot', outPath], {
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
): Promise<void> {
  // Capture with the XCTest runner, then pull from the runner container.
  // Devices use `devicectl ... copy from`; simulators use `simctl get_app_container`.
  const result = await runAppleRunnerCommand(
    device,
    {
      command: 'screenshot',
      appBundleId,
      fullscreen,
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

  if (isMacOs(device)) {
    await fs.copyFile(remoteFileName, outPath);
    return;
  }

  if (device.kind === 'simulator') {
    await copyRunnerScreenshotFromSimulator(device, remoteFileName, outPath);
    return;
  }
  await copyRunnerScreenshotFromDevice(device, remoteFileName, outPath);
}

async function copyRunnerScreenshotFromDevice(
  device: DeviceInfo,
  remoteFileName: string,
  outPath: string,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS);
  let copyResult = { exitCode: 1, stdout: '', stderr: '' };
  for (const bundleId of IOS_RUNNER_CONTAINER_BUNDLE_IDS) {
    copyResult = await runXcrun(
      [
        'devicectl',
        'device',
        'copy',
        'from',
        '--device',
        device.id,
        '--source',
        remoteFileName,
        '--destination',
        outPath,
        '--domain-type',
        'appDataContainer',
        '--domain-identifier',
        bundleId,
      ],
      {
        allowFailure: true,
        timeoutMs: resolveDeadlineTimeoutMs(
          deadline,
          IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS,
          'runner screenshot copy',
        ),
      },
    );
    if (copyResult.exitCode === 0) {
      return;
    }
  }
  const copyError =
    copyResult.stderr.trim() ||
    copyResult.stdout.trim() ||
    `devicectl exited with code ${copyResult.exitCode}`;
  throw new AppError('COMMAND_FAILED', `Failed to capture iOS screenshot: ${copyError}`);
}

async function copyRunnerScreenshotFromSimulator(
  device: DeviceInfo,
  remoteFileName: string,
  outPath: string,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS);
  let lastError = 'Unable to locate runner container for simulator screenshot';
  for (const bundleId of IOS_RUNNER_CONTAINER_BUNDLE_IDS) {
    const containerResult = await runSimctl(
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
    const candidateSourcePaths = resolveSimulatorRunnerScreenshotCandidatePaths(
      containerPath,
      remoteFileName,
    );
    for (const sourcePath of candidateSourcePaths) {
      try {
        await fs.copyFile(sourcePath, outPath);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  throw new AppError('COMMAND_FAILED', `Failed to capture iOS screenshot: ${lastError}`);
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
  from: 'simctl_screenshot' | 'devicectl_screenshot',
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
  const remotePosixPath = relativeFromRoot.replace(/\\/g, '/');
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

export function shouldFallbackToRunnerForIosScreenshot(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code !== 'COMMAND_FAILED') return false;
  const combined = commandFailureText(error);
  return (
    combined.includes("unknown option '--device'") ||
    (combined.includes('unknown subcommand') && combined.includes('screenshot')) ||
    (combined.includes('unrecognized subcommand') && combined.includes('screenshot'))
  );
}

export function shouldRetryIosSimulatorScreenshot(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code !== 'COMMAND_FAILED') return false;
  const combined = commandFailureText(error);
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
  const combined = commandFailureText(error);
  return (
    combined.includes('not booted') ||
    combined.includes('current state: shutdown') ||
    combined.includes('current state is shutdown') ||
    combined.includes('current state=shutdown') ||
    combined.includes('state: shutdown') ||
    combined.includes('state=shutdown')
  );
}

function commandFailureText(error: AppError): string {
  const details = (error.details ?? {}) as { stdout?: unknown; stderr?: unknown; args?: unknown };
  const stdout = typeof details.stdout === 'string' ? details.stdout : '';
  const stderr = typeof details.stderr === 'string' ? details.stderr : '';
  const args = Array.isArray(details.args)
    ? details.args.filter((value): value is string => typeof value === 'string').join(' ')
    : '';
  return `${error.message}\n${stdout}\n${stderr}\n${args}`.toLowerCase();
}

async function normalizeIosSimulatorScreenshotDensity(
  device: DeviceInfo,
  outPath: string,
  pixelDensity: number | undefined,
): Promise<void> {
  const sourcePixelDensity = await readIosSimulatorMainScreenScale(device);
  const targetSize = computeDensityScaledScreenshotSize(
    await readPngSize(outPath),
    sourcePixelDensity,
    pixelDensity,
  );
  if (targetSize) await resizePngFile(outPath, targetSize.width, targetSize.height);
}

async function readIosSimulatorMainScreenScale(device: DeviceInfo): Promise<number> {
  const cachedScale = iosSimulatorMainScreenScaleCache.get(device.id);
  if (cachedScale !== undefined) {
    return cachedScale;
  }
  const scaleResult = await runSimctl(device, ['getenv', device.id, 'SIMULATOR_MAINSCREEN_SCALE'], {
    timeoutMs: 5_000,
  });
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

export { prepareSimulatorStatusBarForScreenshot } from './screenshot-status-bar.ts';
