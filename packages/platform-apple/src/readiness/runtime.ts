import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
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
    await bootSimulator(host, device, signal);
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
): Promise<void> {
  let started = false;
  try {
    const boot = await host.appleTools.run(
      {
        tool: 'simctl',
        args: simctlArgs(device, ['boot', device.id]),
        allowFailure: true,
        timeoutMs: BOOT_TIMEOUT_MS,
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
    started = !alreadyBooted;
    const status = await host.appleTools.run(
      {
        tool: 'simctl',
        args: simctlArgs(device, ['bootstatus', device.id, '-b']),
        allowFailure: true,
        timeoutMs: BOOT_TIMEOUT_MS,
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
    if ((await simulatorState(host, device, signal)) !== 'Booted') {
      throw new AppError('COMMAND_FAILED', 'Simulator is still booting', { deviceId: device.id });
    }
  } catch (error) {
    if (started && signal.aborted) scheduleSimulatorShutdown(host, device);
    signal.throwIfAborted();
    throw error;
  }
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
