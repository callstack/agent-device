import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitRequestProgress } from '@agent-device/host-kit/request';
import { delegateManagedDeviceReadiness } from '@agent-device/provision-kit/managed-device-scope';
import { getSimulatorState, simctlArgs } from '../simulator-state.ts';

/** Readiness reads exactly these host ports; the lifecycle binding composes the same subset. */
export type AppleReadinessHost = Pick<
  PlatformRuntimeHost,
  'appleTools' | 'commands' | 'deviceReadiness'
>;

const BOOT_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 15_000;

export type AppleReadinessOptions = Readonly<{
  /**
   * Absolute deadline for the Simulator boot wait. A first boot runs Apple's data migration and
   * can take minutes, so a caller-stated `--timeout` must reach this wait instead of the
   * 120-second default preempting it (#2324). Without a deadline the default applies.
   */
  deadlineAtMs?: number;
  /**
   * Runs when this call is about to cold-boot the simulator. `open` uses it to start warming the
   * runner cache in parallel with the boot, which is the whole reason the hook exists.
   */
  onColdBootStart?: () => void;
}>;

export async function ensureAppleReady(
  host: AppleReadinessHost,
  device: DeviceInfo,
  signal: AbortSignal,
  options: AppleReadinessOptions = {},
): Promise<DeviceInfo> {
  signal.throwIfAborted();
  if (await delegateManagedDeviceReadiness(device)) return { ...device, booted: true };
  if (isMacOs(device)) return { ...device, booted: true };
  if (device.kind === 'device') {
    await host.deviceReadiness.applePhysical.ensureConnected(device, signal);
    return { ...device, booted: true };
  }
  if (device.kind !== 'simulator') return { ...device, booted: true };

  const recentlyObservedBooted = await readRecentBootObservation(host, device);
  const state = recentlyObservedBooted ? 'Booted' : await simulatorState(host, device, signal);
  if (state !== 'Booted') {
    options.onColdBootStart?.();
    host.deviceReadiness.appleAutomation.keepHot(device);
    await bootSimulator(host, device, signal, options.deadlineAtMs);
    await showSimulator(host, signal);
  }
  host.deviceReadiness.appleAutomation.keepHot(device);
  // Publish the fresh observation so the boot checks later in this flow skip their own listing.
  host.deviceReadiness.appleAutomation.markBooted(device);
  return { ...device, booted: true };
}

async function readRecentBootObservation(
  host: AppleReadinessHost,
  device: DeviceInfo,
): Promise<boolean> {
  try {
    return await host.deviceReadiness.appleAutomation.wasRecentlyObservedBooted(device);
  } catch {
    return false;
  }
}

async function bootSimulator(
  host: AppleReadinessHost,
  device: DeviceInfo,
  signal: AbortSignal,
  deadlineAtMs = Date.now() + BOOT_TIMEOUT_MS,
): Promise<void> {
  let started = false;
  try {
    started = await startSimulatorBoot(host, device, signal, deadlineAtMs);
    await waitForSimulatorBoot(host, device, signal, deadlineAtMs);
  } catch (error) {
    if (started && signal.aborted) scheduleSimulatorShutdown(host, device);
    signal.throwIfAborted();
    // The wait ended past its deadline: report the budget, not whichever tool call it cut short.
    // The Simulator keeps booting so the next attempt finds it further along or ready.
    if (Date.now() >= deadlineAtMs) throw bootDeadlineError(device, error);
    throw error;
  }
}

/** Issues `simctl boot`; true when this call started the boot, false when it was already booted. */
async function startSimulatorBoot(
  host: AppleReadinessHost,
  device: DeviceInfo,
  signal: AbortSignal,
  deadlineAtMs: number,
): Promise<boolean> {
  const boot = await host.appleTools.run(
    {
      tool: 'simctl',
      args: simctlArgs(device, ['boot', device.id]),
      allowFailure: true,
      timeoutMs: remainingBootBudgetMs(deadlineAtMs, device),
    },
    signal,
  );
  const output = `${boot.stdout}\n${boot.stderr}`.toLowerCase();
  const alreadyBooted =
    output.includes('already booted') || output.includes('current state: booted');
  if (boot.exitCode !== 0 && !alreadyBooted) {
    throw new AppError('COMMAND_FAILED', 'simctl boot failed', {
      stdout: boot.stdout,
      stderr: boot.stderr,
      exitCode: boot.exitCode,
    });
  }
  return !alreadyBooted;
}

async function waitForSimulatorBoot(
  host: AppleReadinessHost,
  device: DeviceInfo,
  signal: AbortSignal,
  deadlineAtMs: number,
): Promise<void> {
  emitRequestProgress({
    type: 'command',
    status: 'progress',
    message: 'Waiting for the Simulator to finish booting...',
  });
  const status = await host.appleTools.run(
    {
      tool: 'simctl',
      args: simctlArgs(device, ['bootstatus', device.id, '-b']),
      allowFailure: true,
      timeoutMs: remainingBootBudgetMs(deadlineAtMs, device),
    },
    signal,
  );
  if (status.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'simctl bootstatus failed', {
      stdout: status.stdout,
      stderr: status.stderr,
      exitCode: status.exitCode,
    });
  }
  // The confirming listing runs inside the same budget, and a confirmation that lands after the
  // deadline is still a timeout: the caller's budget is the contract, not the boot's outcome.
  const state = await getSimulatorState(
    host.appleTools,
    device,
    signal,
    Math.min(LIST_TIMEOUT_MS, remainingBootBudgetMs(deadlineAtMs, device)),
  );
  if (state !== 'Booted') {
    throw new AppError('COMMAND_FAILED', 'Simulator is still booting', { deviceId: device.id });
  }
  if (Date.now() >= deadlineAtMs) throw bootDeadlineError(device);
}

function remainingBootBudgetMs(deadlineAtMs: number, device: DeviceInfo): number {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw bootDeadlineError(device);
  return remainingMs;
}

function bootDeadlineError(device: DeviceInfo, cause?: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Simulator did not finish booting within the startup budget',
    {
      reason: 'boot_timeout',
      deviceId: device.id,
      hint: 'The Simulator keeps booting in the background; a first boot can take several minutes. Retry once it is up, or pass a larger --timeout.',
    },
    cause instanceof Error ? cause : undefined,
  );
}

async function simulatorState(
  host: AppleReadinessHost,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<string | null> {
  return await getSimulatorState(host.appleTools, device, signal, LIST_TIMEOUT_MS);
}

async function showSimulator(host: AppleReadinessHost, signal: AbortSignal): Promise<void> {
  await host.commands.run(
    { executable: 'open', args: ['-a', 'Simulator'], allowFailure: true, timeoutMs: 10_000 },
    signal,
  );
}

function scheduleSimulatorShutdown(host: AppleReadinessHost, device: DeviceInfo): void {
  void host.appleTools
    .run({ tool: 'simctl', args: simctlArgs(device, ['shutdown', device.id]), allowFailure: true })
    .catch(() => {});
}
