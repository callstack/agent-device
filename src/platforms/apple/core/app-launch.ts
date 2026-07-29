import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isIosFamily, isMacOs, type DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { emitDiagnostic } from '../../../utils/diagnostics.ts';
import { execFailureDetails } from '../../../utils/exec.ts';
import {
  LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE,
  LAUNCH_CONSOLE_IOS_SIMULATOR_ONLY_MESSAGE,
} from '../../../contracts/launch-console.ts';
import { Deadline, retryWithPolicy } from '../../../utils/retry.ts';
import {
  isDeepLinkTarget,
  isWebUrl,
  resolveIosDeviceDeepLinkBundleId,
} from '../../../contracts/open-target.ts';
import { IOS_APP_LAUNCH_TIMEOUT_MS, IOS_SIMULATOR_TERMINATE_TIMEOUT_MS } from './config.ts';
import { resolveIosPhysicalDeviceControl } from './physical-device-control.ts';
import { runAppleRunnerCommand } from './runner/runner-client.ts';
import type { AppleRunnerCommandOptions } from './runner/runner-provider.ts';
import {
  isSimulatorLaunchFBSError,
  probeSimulatorLaunchContext,
  classifyLaunchFailure,
  launchFailureHint,
} from './launch-diagnostics.ts';
import { ensureBootedSimulator, getSimulatorState } from './simulator.ts';
import { runXcrun } from './tool-provider.ts';
import { closeMacOsApp, openMacOsApp } from '../os/macos/apps.ts';
import { resolveIosApp } from './app-resolution.ts';
import { runSimctl, simctlArgs } from './apps-simctl.ts';

const IOS_SIMULATOR_CONSOLE_CAPTURE_MS = 25_000;
const IOS_SIMULATOR_LAUNCH_ARGS_WITH_URL_MESSAGE =
  '--launch-args is not supported with iOS simulator URL opens (simctl openurl ignores launch args). Launch the app first with --launch-args, then issue the URL open in a separate call.';

// fallow-ignore-next-line complexity
export async function openIosApp(
  device: DeviceInfo,
  app: string,
  options?: {
    appBundleId?: string;
    launchConsole?: string;
    launchArgs?: string[];
    terminateRunningApp?: boolean;
    url?: string;
    runnerOptions?: AppleRunnerCommandOptions;
  },
): Promise<void> {
  const launchConsole = options?.launchConsole?.trim();
  const launchArgs = options?.launchArgs;
  if (launchConsole && (!isIosFamily(device) || device.kind !== 'simulator')) {
    throw new AppError('UNSUPPORTED_OPERATION', LAUNCH_CONSOLE_IOS_SIMULATOR_ONLY_MESSAGE);
  }
  if (isMacOs(device)) {
    if (launchArgs && launchArgs.length > 0) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        '--launch-args is not supported on macOS; launch arguments are currently iOS-only.',
      );
    }
    await openMacOsApp(device, app, options);
    return;
  }
  const explicitUrl = options?.url?.trim();
  if (explicitUrl) {
    if (launchConsole) {
      throw new AppError('INVALID_ARGS', LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE);
    }
    if (!isDeepLinkTarget(explicitUrl)) {
      throw new AppError('INVALID_ARGS', 'open <app> <url> requires a valid URL target');
    }
    if (device.kind === 'simulator') {
      const shouldLaunchAppBeforeUrl = Boolean(launchArgs) || isWebUrl(explicitUrl);
      if (options?.terminateRunningApp || shouldLaunchAppBeforeUrl) {
        const bundleId = options?.appBundleId ?? (await resolveIosApp(device, app));
        if (shouldLaunchAppBeforeUrl) {
          await launchIosSimulatorApp(device, bundleId, {
            ...(launchArgs ? { launchArgs } : {}),
            ...(options?.terminateRunningApp ? { terminateRunningApp: true } : {}),
          });
        } else {
          await terminateIosSimulatorApp(device, bundleId);
        }
      }
      await openIosSimulatorUrl(device, explicitUrl, undefined);
      return;
    }
    const appBundleId = options?.appBundleId ?? (await resolveIosApp(device, app));
    const bundleId = resolveIosDeviceDeepLinkBundleId(appBundleId, explicitUrl);
    if (!bundleId) {
      throw new AppError(
        'INVALID_ARGS',
        'Deep link open on iOS devices requires an active app bundle ID. Open the app first, then open the URL.',
      );
    }
    await launchIosDeviceProcess(device, bundleId, {
      payloadUrl: explicitUrl,
      launchArgs,
      runnerOptions: options?.runnerOptions,
    });
    return;
  }

  const deepLinkTarget = app.trim();
  if (isDeepLinkTarget(deepLinkTarget)) {
    if (launchConsole) {
      throw new AppError('INVALID_ARGS', LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE);
    }
    if (device.kind === 'simulator') {
      await openIosSimulatorUrl(device, deepLinkTarget, launchArgs);
      return;
    }
    const bundleId = resolveIosDeviceDeepLinkBundleId(options?.appBundleId, deepLinkTarget);
    if (!bundleId) {
      throw new AppError(
        'INVALID_ARGS',
        'Deep link open on iOS devices requires an active app bundle ID. Open the app first, then open the URL.',
      );
    }
    await launchIosDeviceProcess(device, bundleId, {
      payloadUrl: deepLinkTarget,
      launchArgs,
      runnerOptions: options?.runnerOptions,
    });
    return;
  }

  const bundleId = options?.appBundleId ?? (await resolveIosApp(device, app));
  if (device.kind === 'simulator') {
    await launchIosSimulatorApp(device, bundleId, {
      ...(launchConsole ? { launchConsole } : {}),
      ...(launchArgs ? { launchArgs } : {}),
      ...(options?.terminateRunningApp ? { terminateRunningApp: true } : {}),
    });
    return;
  }

  await launchIosDeviceProcess(device, bundleId, {
    launchArgs,
    runnerOptions: options?.runnerOptions,
  });
}

async function openIosSimulatorUrl(
  device: DeviceInfo,
  url: string,
  launchArgs: string[] | undefined,
): Promise<void> {
  if (launchArgs && launchArgs.length > 0) {
    throw new AppError('INVALID_ARGS', IOS_SIMULATOR_LAUNCH_ARGS_WITH_URL_MESSAGE);
  }
  await ensureBootedSimulator(device);
  await runSimctl(device, ['openurl', device.id, url]);
}

export async function openIosDevice(device: DeviceInfo): Promise<void> {
  if (isMacOs(device)) {
    return;
  }
  if (device.kind !== 'simulator') return;
  const state = await getSimulatorState(device);
  if (state === 'Booted') return;

  await ensureBootedSimulator(device);
}

export async function closeIosApp(
  device: DeviceInfo,
  app: string,
  runnerOptions?: AppleRunnerCommandOptions,
): Promise<void> {
  if (isMacOs(device)) {
    await closeMacOsApp(device, app);
    return;
  }
  const bundleId = await resolveIosApp(device, app);
  if (device.kind === 'simulator') {
    await terminateIosSimulatorApp(device, bundleId);
    return;
  }

  await resolveIosPhysicalDeviceControl(device).terminateApp(device, bundleId, {
    runnerOptions,
    runRunnerCommand: runAppleRunnerCommand,
  });
}

async function terminateIosSimulatorApp(device: DeviceInfo, bundleId: string): Promise<void> {
  await ensureBootedSimulator(device);
  const terminateArgs = simctlArgs(device, ['terminate', device.id, bundleId]);
  const result = await runXcrun(terminateArgs, {
    allowFailure: true,
    timeoutMs: IOS_SIMULATOR_TERMINATE_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return;
  const stderr = result.stderr.toLowerCase();
  if (stderr.includes('found nothing to terminate')) return;
  throw new AppError(
    'COMMAND_FAILED',
    `xcrun exited with code ${result.exitCode}`,
    execFailureDetails(result, { cmd: 'xcrun', args: terminateArgs }),
  );
}

async function launchIosSimulatorApp(
  device: DeviceInfo,
  bundleId: string,
  options?: { launchConsole?: string; launchArgs?: string[]; terminateRunningApp?: boolean },
): Promise<void> {
  await ensureBootedSimulator(device);

  let consecutiveFBSFailures = 0;
  const MAX_CONSECUTIVE_FBS_FAILURES = 3;

  const launchDeadline = Deadline.fromTimeoutMs(IOS_APP_LAUNCH_TIMEOUT_MS);
  try {
    await retryWithPolicy(
      async ({ deadline: attemptDeadline }) => {
        if (attemptDeadline?.isExpired()) {
          throw new AppError('COMMAND_FAILED', 'App launch deadline exceeded', {
            timeoutMs: IOS_APP_LAUNCH_TIMEOUT_MS,
          });
        }

        const launchArgs = simctlArgs(
          device,
          buildIosSimulatorLaunchArgs(device.id, bundleId, options),
        );
        const result = options?.launchConsole
          ? await runIosSimulatorConsoleLaunch(launchArgs, options.launchConsole)
          : await runXcrun(launchArgs, {
              allowFailure: true,
            });
        if (result.exitCode === 0) return;

        throw new AppError(
          'COMMAND_FAILED',
          `xcrun exited with code ${result.exitCode}`,
          execFailureDetails(result, { cmd: 'xcrun', args: launchArgs }),
        );
      },
      {
        maxAttempts: 10,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
        jitter: 0.2,
        shouldRetry(error: unknown) {
          if (!isSimulatorLaunchFBSError(error)) return false;
          consecutiveFBSFailures += 1;
          return consecutiveFBSFailures < MAX_CONSECUTIVE_FBS_FAILURES;
        },
      },
      { deadline: launchDeadline },
    );
  } catch (error) {
    if (isSimulatorLaunchFBSError(error)) {
      const appError = error as AppError;
      const probe = await probeSimulatorLaunchContext(device, bundleId);
      const reason = classifyLaunchFailure(probe);
      appError.details = { ...appError.details, hint: launchFailureHint(reason) };
    }
    throw error;
  }
}

function buildIosSimulatorLaunchArgs(
  deviceId: string,
  bundleId: string,
  options?: { launchConsole?: string; launchArgs?: string[]; terminateRunningApp?: boolean },
): string[] {
  const args = ['launch'];
  if (options?.launchConsole) args.push('--console-pty');
  if (options?.terminateRunningApp) args.push('--terminate-running-process');
  args.push(deviceId, bundleId);
  if (options?.launchArgs && options.launchArgs.length > 0) {
    args.push(...options.launchArgs);
  }
  return args;
}

async function runIosSimulatorConsoleLaunch(
  launchArgs: string[],
  logPath: string,
): Promise<Awaited<ReturnType<typeof runXcrun>>> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  try {
    const result = await runXcrun(launchArgs, {
      allowFailure: true,
      timeoutMs: IOS_SIMULATOR_CONSOLE_CAPTURE_MS,
    });
    await writeIosSimulatorConsoleLog(logPath, result.stdout, result.stderr);
    return result;
  } catch (error) {
    const appError = error instanceof AppError ? error : undefined;
    const details = appError?.details;
    if (details?.timeoutMs === IOS_SIMULATOR_CONSOLE_CAPTURE_MS) {
      const stdout = typeof details.stdout === 'string' ? details.stdout : '';
      const stderr = typeof details.stderr === 'string' ? details.stderr : '';
      await writeIosSimulatorConsoleLog(logPath, stdout, stderr);
      emitDiagnostic({
        level: 'warn',
        phase: 'ios_simulator_launch_console_capture_timeout',
        data: {
          timeoutMs: IOS_SIMULATOR_CONSOLE_CAPTURE_MS,
          logPath,
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: Buffer.byteLength(stderr),
        },
      });
      return { stdout, stderr, exitCode: 0 };
    }
    throw error;
  }
}

async function writeIosSimulatorConsoleLog(
  logPath: string,
  stdout: string,
  stderr: string,
): Promise<void> {
  await fs.writeFile(logPath, joinProcessOutput(stdout, stderr), 'utf8');
}

function joinProcessOutput(stdout: string, stderr: string): string {
  if (!stdout || !stderr || stdout.endsWith('\n') || stdout.endsWith('\r')) {
    return `${stdout}${stderr}`;
  }
  return `${stdout}\n${stderr}`;
}

async function launchIosDeviceProcess(
  device: DeviceInfo,
  bundleId: string,
  options?: {
    payloadUrl?: string;
    launchArgs?: string[];
    runnerOptions?: AppleRunnerCommandOptions;
  },
): Promise<void> {
  await resolveIosPhysicalDeviceControl(device).launchApp(device, bundleId, {
    ...options,
    runRunnerCommand: runAppleRunnerCommand,
  });
}
