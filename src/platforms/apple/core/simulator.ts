import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { execFailureDetails, requireExecSuccess } from '../../../utils/exec.ts';
import { Deadline, retryWithPolicy } from '../../../utils/retry.ts';
import { createTtlMemo } from '../../../utils/ttl-memo.ts';
import { bootFailureHint, classifyBootFailure } from '../../boot-diagnostics.ts';

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

// Recently-observed-Booted memo. `simctl list devices -j` costs ~0.7s per
// spawn, and a single open --relaunch used to pay it three times (resolve,
// close, launch). Mirrors the DEVICE_READY_CACHE_TTL_MS tradeoff at the daemon
// layer: a simulator shut down externally inside the window surfaces the raw
// simctl error instead of an auto-boot. Transitions we own update the memo.
// Exported so unit tests can assert TTL behavior without duplicating the value.
export const SIMULATOR_BOOTED_MEMO_TTL_MS = 5_000;
const simulatorBootedMemo = createTtlMemo<string, true>({ ttlMs: SIMULATOR_BOOTED_MEMO_TTL_MS });

function simulatorBootedMemoKey(device: DeviceInfo): string {
  return `${device.id}|${device.simulatorSetPath ?? ''}`;
}

function readSimulatorBootedMemo(device: DeviceInfo): boolean {
  return simulatorBootedMemo.get(simulatorBootedMemoKey(device)) === true;
}

// Also called by the device-inventory parser: a `simctl list` that reports a
// simulator Booted is the same observation ensureBootedSimulator would make,
// so resolving a device seeds the memo and the boot checks that follow in the
// same request cost nothing. Callers must only pass FRESH observations —
// seeding from a cached or persisted device listing would poison the memo.
export function markSimulatorBooted(device: DeviceInfo): void {
  simulatorBootedMemo.set(simulatorBootedMemoKey(device), true);
}

function clearSimulatorBootedMemo(device: DeviceInfo): void {
  simulatorBootedMemo.delete(simulatorBootedMemoKey(device));
}

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

  const state = readSimulatorBootedMemo(device) ? 'Booted' : await getSimulatorState(device);
  if (state === 'Booted') {
    markSimulatorBooted(device);
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
        bootResult = boot;

        const bootOutput = `${bootResult.stdout}\n${bootResult.stderr}`.toLowerCase();
        const bootAlreadyDone =
          bootOutput.includes('already booted') || bootOutput.includes('current state: booted');

        if (bootResult.exitCode !== 0 && !bootAlreadyDone) {
          throw new AppError(
            'COMMAND_FAILED',
            'simctl boot failed',
            execFailureDetails(bootResult),
          );
        }

        const bootStatus = await runXcrun(
          buildSimctlArgsForDevice(device, ['bootstatus', device.id, '-b']),
          {
            allowFailure: true,
            timeoutMs: remainingMs,
          },
        );
        bootStatusResult = bootStatus;

        requireExecSuccess(bootStatusResult, 'simctl bootstatus failed');

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

  markSimulatorBooted(device);
  await openIosSimulatorApp({ deviceHub: options.deviceHub });
}

export async function shutdownSimulator(device: DeviceInfo): Promise<{
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  clearSimulatorBootedMemo(device);
  const args = buildSimctlArgsForDevice(device, ['shutdown', device.id]);
  const result = await runXcrun(args, { allowFailure: true, timeoutMs: 15_000 });
  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
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
    const payload = JSON.parse(result.stdout) as {
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
