import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import { Deadline, retryWithPolicy } from '../../utils/retry.ts';
import { bootFailureHint, classifyBootFailure } from '../boot-diagnostics.ts';

import {
  IOS_BOOT_TIMEOUT_MS,
  IOS_SIMCTL_LIST_TIMEOUT_MS,
  IOS_SIMULATOR_FOCUS_TIMEOUT_MS,
} from './config.ts';
import { buildSimctlArgs, buildSimctlArgsForDevice } from './simctl.ts';
import { runAppleToolCommand, runXcrun } from './tool-provider.ts';

const IOS_SIMULATOR_HOST_APPS = ['Simulator'] as const;
const IOS_DEVICE_HUB_HOST_APPS = ['Device Hub', 'Simulator'] as const;

type OpenIosSimulatorAppOptions = {
  background?: boolean;
  deviceHub?: boolean;
};

type EnsureBootedSimulatorOptions = {
  deviceHub?: boolean;
  focusExisting?: boolean;
  onColdBootStart?: (device: DeviceInfo) => void;
};

export function requireSimulatorDevice(device: DeviceInfo, command: string): void {
  if (device.kind !== 'simulator') {
    throw new AppError('UNSUPPORTED_OPERATION', `${command} is only supported on iOS simulators`);
  }
}

export async function openIosSimulatorApp(options: OpenIosSimulatorAppOptions = {}): Promise<void> {
  const appNames = options.deviceHub ? IOS_DEVICE_HUB_HOST_APPS : IOS_SIMULATOR_HOST_APPS;
  const openArgsPrefix = options.background ? ['-g', '-a'] : ['-a'];
  for (const appName of appNames) {
    const result = await runAppleToolCommand('open', [...openArgsPrefix, appName], {
      allowFailure: true,
      timeoutMs: IOS_SIMULATOR_FOCUS_TIMEOUT_MS,
    });
    if (result.exitCode === 0) return;
  }
}

export async function ensureBootedSimulator(
  device: DeviceInfo,
  options: EnsureBootedSimulatorOptions = {},
): Promise<void> {
  if (device.kind !== 'simulator') return;

  const state = await getSimulatorState(device);
  if (state === 'Booted') {
    if (options.focusExisting) {
      await openIosSimulatorApp({
        background: options.deviceHub,
        deviceHub: options.deviceHub,
      });
    }
    return;
  }
  options.onColdBootStart?.(device);

  const deadline = Deadline.fromTimeoutMs(IOS_BOOT_TIMEOUT_MS);
  let bootResult:
    | {
        stdout: string;
        stderr: string;
        exitCode: number;
      }
    | undefined;
  let bootStatusResult:
    | {
        stdout: string;
        stderr: string;
        exitCode: number;
      }
    | undefined;

  try {
    await retryWithPolicy(
      async ({ deadline: attemptDeadline }) => {
        if (attemptDeadline?.isExpired()) {
          throw new AppError('COMMAND_FAILED', 'iOS simulator boot deadline exceeded', {
            timeoutMs: IOS_BOOT_TIMEOUT_MS,
          });
        }

        const remainingMs = Math.max(1_000, attemptDeadline?.remainingMs() ?? IOS_BOOT_TIMEOUT_MS);
        const boot = await runXcrun(buildSimctlArgsForDevice(device, ['boot', device.id]), {
          allowFailure: true,
          timeoutMs: remainingMs,
        });
        bootResult = {
          stdout: String(boot.stdout ?? ''),
          stderr: String(boot.stderr ?? ''),
          exitCode: boot.exitCode,
        };

        const bootOutput = `${bootResult.stdout}\n${bootResult.stderr}`.toLowerCase();
        const bootAlreadyDone =
          bootOutput.includes('already booted') || bootOutput.includes('current state: booted');

        if (bootResult.exitCode !== 0 && !bootAlreadyDone) {
          throw new AppError('COMMAND_FAILED', 'simctl boot failed', {
            stdout: bootResult.stdout,
            stderr: bootResult.stderr,
            exitCode: bootResult.exitCode,
          });
        }

        const bootStatus = await runXcrun(
          buildSimctlArgsForDevice(device, ['bootstatus', device.id, '-b']),
          {
            allowFailure: true,
            timeoutMs: remainingMs,
          },
        );
        bootStatusResult = {
          stdout: String(bootStatus.stdout ?? ''),
          stderr: String(bootStatus.stderr ?? ''),
          exitCode: bootStatus.exitCode,
        };

        if (bootStatusResult.exitCode !== 0) {
          throw new AppError('COMMAND_FAILED', 'simctl bootstatus failed', {
            stdout: bootStatusResult.stdout,
            stderr: bootStatusResult.stderr,
            exitCode: bootStatusResult.exitCode,
          });
        }

        const nextState = await getSimulatorState(device);
        if (nextState !== 'Booted') {
          throw new AppError('COMMAND_FAILED', 'Simulator is still booting', { state: nextState });
        }
      },
      {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 2000,
        jitter: 0.2,
        shouldRetry: (error) => {
          const reason = classifyBootFailure({
            error,
            stdout: bootStatusResult?.stdout ?? bootResult?.stdout,
            stderr: bootStatusResult?.stderr ?? bootResult?.stderr,
            context: { platform: 'ios', phase: 'boot' },
          });
          return reason !== 'IOS_BOOT_TIMEOUT' && reason !== 'CI_RESOURCE_STARVATION_SUSPECTED';
        },
      },
      {
        deadline,
        phase: 'boot',
        classifyReason: (error) =>
          classifyBootFailure({
            error,
            stdout: bootStatusResult?.stdout ?? bootResult?.stdout,
            stderr: bootStatusResult?.stderr ?? bootResult?.stderr,
            context: { platform: 'ios', phase: 'boot' },
          }),
      },
    );
  } catch (error) {
    const reason = classifyBootFailure({
      error,
      stdout: bootStatusResult?.stdout ?? bootResult?.stdout,
      stderr: bootStatusResult?.stderr ?? bootResult?.stderr,
      context: { platform: 'ios', phase: 'boot' },
    });

    throw new AppError('COMMAND_FAILED', 'iOS simulator failed to boot', {
      platform: 'ios',
      deviceId: device.id,
      timeoutMs: IOS_BOOT_TIMEOUT_MS,
      elapsedMs: deadline.elapsedMs(),
      reason,
      hint: bootFailureHint(reason),
      boot: bootResult,
      bootstatus: bootStatusResult,
    });
  }

  await openIosSimulatorApp({ deviceHub: options.deviceHub });
}

export async function shutdownSimulator(device: DeviceInfo): Promise<{
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const args = buildSimctlArgsForDevice(device, ['shutdown', device.id]);
  const result = await runXcrun(args, { allowFailure: true, timeoutMs: 15_000 });
  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

export async function getSimulatorState(deviceOrUdid: DeviceInfo | string): Promise<string | null> {
  const udid = typeof deviceOrUdid === 'string' ? deviceOrUdid : deviceOrUdid.id;
  const simctlArgs =
    typeof deviceOrUdid === 'string'
      ? buildSimctlArgs(['list', 'devices', '-j'])
      : buildSimctlArgsForDevice(deviceOrUdid, ['list', 'devices', '-j']);
  const result = await runXcrun(simctlArgs, {
    allowFailure: true,
    timeoutMs: IOS_SIMCTL_LIST_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return null;

  try {
    const payload = JSON.parse(String(result.stdout ?? '')) as {
      devices: Record<string, { udid: string; state: string }[]>;
    };

    for (const runtime of Object.values(payload.devices ?? {})) {
      const match = runtime.find((entry) => entry.udid === udid);
      if (match) return match.state;
    }
    return null;
  } catch {
    return null;
  }
}
