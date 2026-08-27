import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import { type ExecResult, runCmdDetached, whichCmd } from '@agent-device/host-kit/command';
import { Deadline, retryWithPolicy, sleep } from '@agent-device/host-kit/retry';

import { runAndroidHostAdb } from './adb-executor.ts';
import { bootFailureHint, classifyBootFailure } from '@agent-device/provision-kit/boot-diagnostics';
import { ensureAndroidSdkPathConfigured } from './sdk.ts';

const ANDROID_BOOT_POLL_MS = 1_000;
const ANDROID_BOOT_PROP_TIMEOUT_MS = 10_000;
const ANDROID_EMULATOR_BOOT_POLL_MS = 1_000;
const ANDROID_EMULATOR_BOOT_TIMEOUT_MS = 120_000;
const ANDROID_EMULATOR_SERIAL_PREFIX = 'emulator-';

export type AndroidEmulatorLifecycleDependencies = Readonly<{
  discoverLocal: (request: DeviceInventoryRequest) => Promise<readonly DeviceInfo[]>;
  androidSerialAllowlist?: readonly string[];
}>;

export async function ensureAndroidEmulatorBooted(
  params: Readonly<{
    avdName: string;
    serial?: string;
    timeoutMs?: number;
    headless?: boolean;
  }>,
  dependencies: AndroidEmulatorLifecycleDependencies,
): Promise<DeviceInfo> {
  await ensureAndroidSdkPathConfigured();
  const requestedAvdName = params.avdName.trim();
  if (!requestedAvdName) {
    throw new AppError('INVALID_ARGS', 'Android emulator boot requires a non-empty AVD name.');
  }
  const timeoutMs = params.timeoutMs ?? ANDROID_EMULATOR_BOOT_TIMEOUT_MS;
  if (!(await whichCmd('adb'))) throw new AppError('TOOL_MISSING', 'adb not found in PATH');
  if (!(await whichCmd('emulator'))) {
    throw new AppError('TOOL_MISSING', 'emulator not found in PATH');
  }

  const available = await discoverAndroidEmulators(dependencies, params.serial);
  const selected = findEmulatorByAvdName(available, requestedAvdName, params.serial);
  if (!selected) {
    throw new AppError('DEVICE_NOT_FOUND', `No Android emulator AVD named ${params.avdName}`, {
      requestedAvdName,
      availableAvds: available.map((device) => device.name),
      hint: 'Run `emulator -list-avds` and pass an existing AVD name to --device.',
    });
  }

  const resolvedAvdName = selected.name;
  const startedAt = Date.now();
  const runningExisting = isRunningEmulator(selected) ? selected : undefined;
  if (!runningExisting) {
    const launchArgs = ['-avd', resolvedAvdName];
    if (params.headless) launchArgs.push('-no-window', '-no-audio');
    runCmdDetached('emulator', launchArgs);
  }

  const discovered =
    runningExisting ??
    (await waitForEmulatorDiscovery({
      dependencies,
      avdName: resolvedAvdName,
      serial: params.serial,
      timeoutMs,
    }));
  const elapsedMs = Date.now() - startedAt;
  await waitForAndroidBoot(discovered.id, Math.max(1_000, timeoutMs - elapsedMs));

  const refreshed = (await discoverAndroidEmulators(dependencies, params.serial)).find(
    (device) => device.id === discovered.id,
  );
  return {
    ...(refreshed ?? discovered),
    name: resolvedAvdName,
    booted: true,
  };
}

async function discoverAndroidEmulators(
  dependencies: AndroidEmulatorLifecycleDependencies,
  serial?: string,
): Promise<readonly DeviceInfo[]> {
  return await dependencies.discoverLocal({
    platform: 'android',
    kind: 'emulator',
    ...(serial ? { serial } : {}),
    ...(dependencies.androidSerialAllowlist
      ? { androidSerialAllowlist: [...dependencies.androidSerialAllowlist] }
      : {}),
  });
}

function findEmulatorByAvdName(
  devices: readonly DeviceInfo[],
  avdName: string,
  serial?: string,
): DeviceInfo | undefined {
  const normalizedName = normalizeAndroidDeviceName(avdName);
  return devices.find(
    (device) =>
      device.platform === 'android' &&
      device.kind === 'emulator' &&
      normalizeAndroidDeviceName(device.name) === normalizedName &&
      (!serial || !isRunningEmulator(device) || device.id === serial),
  );
}

function isRunningEmulator(device: DeviceInfo): boolean {
  return isAndroidEmulatorSerial(device.id);
}

function isAndroidEmulatorSerial(serial: string): boolean {
  return serial.startsWith(ANDROID_EMULATOR_SERIAL_PREFIX);
}

function normalizeAndroidDeviceName(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

async function waitForEmulatorDiscovery(params: {
  dependencies: AndroidEmulatorLifecycleDependencies;
  avdName: string;
  serial?: string;
  timeoutMs: number;
}): Promise<DeviceInfo> {
  const startedAt = Date.now();
  const pollMs = Math.min(
    ANDROID_EMULATOR_BOOT_POLL_MS,
    Math.max(50, Math.floor(params.timeoutMs / 20)),
  );
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const devices = await discoverAndroidEmulators(params.dependencies, params.serial);
      const device = findEmulatorByAvdName(devices, params.avdName, params.serial);
      if (device && isRunningEmulator(device)) return device;
    } catch {
      // Best-effort polling while adb and the emulator process settle.
    }
    await sleep(pollMs);
  }
  throw new AppError('COMMAND_FAILED', 'Android emulator did not appear in time', {
    avdName: params.avdName,
    serial: params.serial,
    timeoutMs: params.timeoutMs,
    hint: 'Check emulator logs and verify the AVD can start from command line.',
  });
}

async function readAndroidBootProp(
  serial: string,
  timeoutMs = ANDROID_BOOT_PROP_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return await runAndroidHostAdb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
    allowFailure: true,
    signal,
    timeoutMs,
  });
}

export async function waitForAndroidBoot(
  serial: string,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const pollMs = Math.min(ANDROID_BOOT_POLL_MS, Math.max(50, Math.floor(timeoutMs / 20)));
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
  let lastBootResult: ExecResult | undefined;
  let timedOut = false;
  try {
    await retryWithPolicy(
      async ({ deadline: attemptDeadline }) => {
        if (attemptDeadline?.isExpired()) {
          timedOut = true;
          throw new AppError('COMMAND_FAILED', 'Android boot deadline exceeded', {
            serial,
            timeoutMs,
            elapsedMs: deadline.elapsedMs(),
            message: 'timeout',
          });
        }
        const remainingMs = Math.max(1_000, attemptDeadline?.remainingMs() ?? timeoutMs);
        const result = await readAndroidBootProp(
          serial,
          Math.min(remainingMs, ANDROID_BOOT_PROP_TIMEOUT_MS),
          signal,
        );
        lastBootResult = result;
        if (result.stdout.trim() === '1') return;
        // exec-guard-allow: getprop exits 0 while the device is still booting;
        // the throw is a retry-loop poll miss, not a process-exit wrap.
        throw new AppError('COMMAND_FAILED', 'Android device is still booting', {
          serial,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      },
      {
        maxAttempts,
        baseDelayMs: pollMs,
        maxDelayMs: pollMs,
        jitter: 0,
        shouldRetry: (error) => {
          const reason = classifyBootFailure({
            error,
            stdout: lastBootResult?.stdout,
            stderr: lastBootResult?.stderr,
            context: { platform: 'android', phase: 'boot' },
          });
          return reason !== 'ADB_TRANSPORT_UNAVAILABLE' && reason !== 'ANDROID_BOOT_TIMEOUT';
        },
      },
      {
        deadline,
        phase: 'boot',
        signal,
        classifyReason: (error) =>
          classifyBootFailure({
            error,
            stdout: lastBootResult?.stdout,
            stderr: lastBootResult?.stderr,
            context: { platform: 'android', phase: 'boot' },
          }),
      },
    );
  } catch (error) {
    throwAndroidBootFailure({ error, serial, timeoutMs, deadline, lastBootResult, timedOut });
  }
}

function throwAndroidBootFailure(params: {
  error: unknown;
  serial: string;
  timeoutMs: number;
  deadline: Deadline;
  lastBootResult?: ExecResult;
  timedOut: boolean;
}): never {
  const appError = asAppError(params.error);
  const reason = normalizedAndroidBootFailureReason(params, appError);
  throw buildAndroidBootError(
    appError,
    reason,
    params.timedOut,
    buildAndroidBootFailureDetails(params, reason),
  );
}

function normalizedAndroidBootFailureReason(
  params: Parameters<typeof throwAndroidBootFailure>[0],
  appError: AppError,
): ReturnType<typeof classifyBootFailure> {
  const classified = classifyBootFailure({
    error: params.error,
    stdout: params.lastBootResult?.stdout,
    stderr: params.lastBootResult?.stderr,
    context: { platform: 'android', phase: 'boot' },
  });
  return classified === 'BOOT_COMMAND_FAILED' &&
    appError.message === 'Android device is still booting'
    ? 'ANDROID_BOOT_TIMEOUT'
    : classified;
}

function buildAndroidBootFailureDetails(
  params: Parameters<typeof throwAndroidBootFailure>[0],
  reason: ReturnType<typeof classifyBootFailure>,
) {
  return {
    serial: params.serial,
    timeoutMs: params.timeoutMs,
    elapsedMs: params.deadline.elapsedMs(),
    reason,
    hint: bootFailureHint(reason),
    stdout: params.lastBootResult?.stdout,
    stderr: params.lastBootResult?.stderr,
    exitCode: params.lastBootResult?.exitCode,
    ...(asAppError(params.error).details ?? {}),
  };
}

function buildAndroidBootError(
  appError: AppError,
  reason: ReturnType<typeof classifyBootFailure>,
  timedOut: boolean,
  details: ReturnType<typeof buildAndroidBootFailureDetails>,
): AppError {
  if (timedOut || reason === 'ANDROID_BOOT_TIMEOUT') {
    return new AppError('COMMAND_FAILED', 'Android device did not finish booting in time', details);
  }
  if (appError.code === 'TOOL_MISSING') {
    return new AppError('TOOL_MISSING', appError.message, details);
  }
  if (reason === 'ADB_TRANSPORT_UNAVAILABLE') {
    return new AppError('COMMAND_FAILED', appError.message, details);
  }
  return new AppError(appError.code, appError.message, details, appError.cause);
}
