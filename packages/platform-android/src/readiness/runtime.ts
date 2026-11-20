import {
  BOOT_TIMEOUT_REASON,
  type EnsureReadyInput,
} from '@agent-device/contracts/device-readiness-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { HostCommandResult } from '@agent-device/contracts/platform-runtime-host';

/** Readiness reads exactly these host ports; the lifecycle binding composes the same subset. */
export type AndroidReadinessHost = Pick<
  PlatformRuntimeHost,
  'clock' | 'commands' | 'deviceReadiness' | 'toolchains'
>;
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { bootFailureHint } from '@agent-device/provision-kit/boot-diagnostics';
import { androidAdbResultError, attachAdbFailureHint } from '../adb-executor.ts';
import {
  androidBootFailureReason,
  buildAndroidBootError,
  isTransientAndroidBootFailure,
} from '../emulator-lifecycle.ts';

const BOOT_TIMEOUT_MS = 120_000;
const POLL_MS = 1_000;

export async function ensureAndroidReady(
  host: AndroidReadinessHost,
  device: DeviceInfo,
  input: EnsureReadyInput & Readonly<{ headless: boolean }>,
  signal: AbortSignal,
): Promise<DeviceInfo> {
  signal.throwIfAborted();
  if (device.kind === 'emulator' && (device.booted !== true || !isRunningEmulator(device))) {
    return await ensureEmulatorReady(host, device, input, signal);
  }
  if (device.booted !== true) {
    await waitForBoot(host, device.id, bootDeadlineAtMs(host, input), signal);
  }
  return { ...device, booted: true };
}

async function ensureEmulatorReady(
  host: AndroidReadinessHost,
  device: DeviceInfo,
  input: EnsureReadyInput & Readonly<{ headless: boolean }>,
  signal: AbortSignal,
): Promise<DeviceInfo> {
  await prepareAndroidEmulatorToolchain(host);
  const request = inventoryRequest(input);
  const deadlineAtMs = bootDeadlineAtMs(host, input);
  const available = await host.deviceReadiness.androidEmulator.discover(request, signal);
  const selected = requireAvailableAvd(available, device.name, input.serial);

  const existing = isRunningEmulator(selected) ? selected : undefined;
  const launchedPid = existing
    ? undefined
    : await host.deviceReadiness.androidEmulator.launch(
        selected.name,
        input.headless,
        deadlineAtMs - host.clock.now(),
      );
  try {
    const discovered =
      existing ??
      (await waitForDiscovery(host, selected.name, request, input.serial, deadlineAtMs, signal));
    await waitForBoot(host, discovered.id, deadlineAtMs, signal);
    const refreshed = (await host.deviceReadiness.androidEmulator.discover(request, signal)).find(
      (candidate) => candidate.id === discovered.id,
    );
    const ready = { ...(refreshed ?? discovered), name: selected.name, booted: true };
    if (launchedPid !== undefined && input.onAndroidEmulatorLaunch) {
      const identity = await host.deviceReadiness.androidEmulator.bindLaunchedEmulator?.(
        launchedPid,
        ready,
      );
      signal.throwIfAborted();
      input.onAndroidEmulatorLaunch(identity);
    }
    return ready;
  } catch (error) {
    if (launchedPid !== undefined && !keepsBootAfterFailure(host, error, deadlineAtMs, signal)) {
      // This request's launch has no boot left to wait for: it goes with the failure, so no
      // emulator is left running with no session to own it (#4847).
      await terminateLaunch(host, launchedPid, error);
    }
    signal.throwIfAborted();
    throw error;
  }
}

/**
 * Whether a failed boot leaves its emulator booting, and so leaves this request's launch running.
 * A canceled request always answers stopped — the abort owner owns that decision. Otherwise only a
 * failure that spent the startup budget keeps booting: each poller throws {@link bootTimeoutError}
 * once `clock.now()` passes `deadlineAtMs`, and a boot probe that fails at or past that same
 * deadline reports its own spent budget rather than `BOOT_TIMEOUT_REASON` (see
 * `buildAndroidBootError`). Every other refusal — the host could not record the launch, a probe
 * failed inside the budget, discovery went wrong — has no boot left to wait for.
 */
function keepsBootAfterFailure(
  host: AndroidReadinessHost,
  error: unknown,
  deadlineAtMs: number,
  signal: AbortSignal,
): boolean {
  if (signal.aborted) return false;
  return (
    host.clock.now() >= deadlineAtMs || asAppError(error).details?.reason === BOOT_TIMEOUT_REASON
  );
}

/**
 * Stops the process this request launched, and never replaces the failure that caused the stop: a
 * host that refuses to signal reports a diagnostic naming that failure instead.
 */
async function terminateLaunch(
  host: AndroidReadinessHost,
  launchedPid: number,
  bootFailure: unknown,
): Promise<void> {
  try {
    await host.deviceReadiness.androidEmulator.terminate(launchedPid);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_emulator_launch_terminate_failed',
      data: {
        pid: launchedPid,
        error: error instanceof Error ? error.message : String(error),
        bootFailure: bootFailure instanceof Error ? bootFailure.message : String(bootFailure),
      },
    });
  }
}

async function prepareAndroidEmulatorToolchain(host: AndroidReadinessHost): Promise<void> {
  await host.toolchains.prepare('android');
  if (!(await host.commands.which('adb'))) {
    throw new AppError('TOOL_MISSING', 'adb not found in PATH');
  }
  if (!(await host.commands.which('emulator'))) {
    throw new AppError('TOOL_MISSING', 'emulator not found in PATH');
  }
}

function requireAvailableAvd(
  available: readonly DeviceInfo[],
  avdName: string,
  serial?: string,
): DeviceInfo {
  const selected = findByAvdName(available, avdName, serial);
  if (selected) return selected;
  throw new AppError('DEVICE_NOT_FOUND', `No Android emulator AVD named ${avdName}`, {
    requestedAvdName: avdName,
    availableAvds: available.map((candidate) => candidate.name),
    hint: 'Run `emulator -list-avds` and pass an existing AVD name to --device.',
  });
}

async function waitForDiscovery(
  host: AndroidReadinessHost,
  avdName: string,
  request: ReturnType<typeof inventoryRequest>,
  serial: string | undefined,
  deadline: number,
  signal: AbortSignal,
): Promise<DeviceInfo> {
  while (host.clock.now() < deadline) {
    const devices = await host.deviceReadiness.androidEmulator.discover(request, signal);
    const device = findByAvdName(devices, avdName, serial);
    if (device && isRunningEmulator(device)) return device;
    await host.clock.sleep(POLL_MS, signal);
  }
  throw bootTimeoutError('Android emulator did not appear in time', { avdName, serial });
}

async function waitForBoot(
  host: AndroidReadinessHost,
  serial: string,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  const startedAtMs = host.clock.now();
  while (host.clock.now() < deadline) {
    signal.throwIfAborted();
    const observation = await observeBootProbe(host, serial, deadline, signal);
    if (observation.booted) return;
    // Retry/stop decisions consume the typed probe evidence, never message or stdout wording.
    if (observation.failure && !isTransientAndroidBootFailure(observation.failure)) {
      throwBootProbeFailure(
        host,
        observation.failure,
        serial,
        startedAtMs,
        host.clock.now() >= deadline,
      );
    }
    await host.clock.sleep(POLL_MS, signal);
  }
  throw bootTimeoutError('Android device failed to finish booting', { serial });
}

type BootProbeObservation = Readonly<{ booted: boolean; failure?: AppError }>;

async function observeBootProbe(
  host: AndroidReadinessHost,
  serial: string,
  deadline: number,
  signal: AbortSignal,
): Promise<BootProbeObservation> {
  let result: HostCommandResult;
  try {
    result = await host.commands.run(
      {
        executable: 'adb',
        args: deviceShellArgv('adb', 'shell', ['getprop', 'sys.boot_completed'], ['-s', serial]),
        allowFailure: true,
        timeoutMs: Math.min(10_000, Math.max(1_000, deadline - host.clock.now())),
      },
      signal,
    );
  } catch (error) {
    // Cancellation stays immediate and keeps the abort owner's typed reason.
    signal.throwIfAborted();
    // A non-AppError (a spawn failure, say) is a failed boot command, as it was before the typed
    // evidence: it never reaches the caller as UNKNOWN.
    return { booted: false, failure: attachAdbFailureHint(asAppError(error, 'COMMAND_FAILED')) };
  }
  if (result.stdout.trim() === '1') return { booted: true };
  if (result.exitCode === 0) {
    return {
      booted: false,
      // exec-guard-allow: getprop exits 0 while the device is still booting;
      // the trio is diagnostic context for the poll miss, not an exec-exit wrap.
      failure: new AppError('COMMAND_FAILED', 'Android device is still booting', {
        serial,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        bootObservation: 'not_ready',
      }),
    };
  }
  // The shared adb construction point stamps the typed failure evidence on the failed result.
  // A signal kill reports a null exit code; the adb result shape wants a concrete failure code.
  return {
    booted: false,
    failure: androidAdbResultError(
      'Android boot probe failed',
      { ...result, exitCode: result.exitCode ?? 1 },
      { serial },
    ),
  };
}

function throwBootProbeFailure(
  host: AndroidReadinessHost,
  failure: AppError,
  serial: string,
  startedAtMs: number,
  budgetSpent: boolean,
): never {
  const reason = androidBootFailureReason(failure);
  const details = {
    serial,
    elapsedMs: host.clock.now() - startedAtMs,
    hint: bootFailureHint(reason),
    ...(failure.details ?? {}),
    reason,
  };
  throw buildAndroidBootError(failure, reason, budgetSpent, details);
}

function bootTimeoutError(message: string, details: Record<string, unknown>): AppError {
  return new AppError('COMMAND_FAILED', message, {
    ...details,
    reason: BOOT_TIMEOUT_REASON,
    hint: 'The emulator keeps booting in the background. Retry once it is up, or pass a larger --timeout.',
  });
}

/** The caller's `--timeout` deadline when stated, else the default boot wait from now. */
function bootDeadlineAtMs(host: AndroidReadinessHost, input: EnsureReadyInput): number {
  return input.deadlineAtMs ?? host.clock.now() + BOOT_TIMEOUT_MS;
}

function inventoryRequest(input: EnsureReadyInput) {
  return {
    platform: 'android' as const,
    kind: 'emulator' as const,
    ...(input.serial ? { serial: input.serial } : {}),
    ...(input.androidSerialAllowlist
      ? { androidSerialAllowlist: [...input.androidSerialAllowlist] }
      : {}),
  };
}

function findByAvdName(
  devices: readonly DeviceInfo[],
  avdName: string,
  serial?: string,
): DeviceInfo | undefined {
  const expected = normalizeName(avdName);
  return devices.find(
    (candidate) =>
      candidate.platform === 'android' &&
      candidate.kind === 'emulator' &&
      normalizeName(candidate.name) === expected &&
      (!serial || !isRunningEmulator(candidate) || candidate.id === serial),
  );
}

function isRunningEmulator(device: DeviceInfo): boolean {
  return device.id.startsWith('emulator-');
}

function normalizeName(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replaceAll(/\s+/g, ' ').trim();
}
