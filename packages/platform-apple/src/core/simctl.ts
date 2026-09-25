import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { type ExecOptions, type ExecResult } from '@agent-device/host-kit/command';
import { resolveIosSimulatorDeviceSetPath } from '@agent-device/kernel/device-isolation';
import type { ScopedSimctlArgs } from '@agent-device/contracts/platform-runtime-host';
import { runXcrun, simctlCommand, type ScopedSimctlCommand } from './tool-provider.ts';

declare const simulatorAddress: unique symbol;
/**
 * A simulator udid with the resolved set that holds it (undefined for the default set); minted only
 * from a DeviceInfo. Two devices name the same simulator only when both fields match.
 */
export type SimulatorAddress = Readonly<{ udid: string; simulatorSetPath: string | undefined }> & {
  readonly [simulatorAddress]: true;
};

export function simulatorAddressFor(device: DeviceInfo): SimulatorAddress {
  const simulatorSetPath =
    isIosFamily(device) && device.kind === 'simulator'
      ? resolveIosSimulatorDeviceSetPath(device.simulatorSetPath)
      : undefined;
  return Object.freeze({ udid: device.id, simulatorSetPath }) as SimulatorAddress;
}

function scopeSimctlArgs(
  simulatorSetPath: string | undefined,
  args: readonly string[],
): ScopedSimctlArgs {
  const resolvedSetPath = resolveIosSimulatorDeviceSetPath(simulatorSetPath);
  const scoped = resolvedSetPath ? ['--set', resolvedSetPath, ...args] : [...args];
  return Object.freeze(scoped) as ScopedSimctlArgs;
}

/** `simctl help`: probes that simctl runs at all, so it names no set. */
export function simctlAvailabilityProbeArgs(): ScopedSimctlArgs {
  return scopeSimctlArgs(undefined, ['help']);
}

/** `simctl list devices -j` over one simulator set; `undefined` lists the default set. */
export function simctlListDevicesArgs(simulatorSetPath: string | undefined): ScopedSimctlArgs {
  return scopeSimctlArgs(simulatorSetPath, ['list', 'devices', '-j']);
}

/** Arguments that follow the `simctl` tool name, scoped to the simulator set holding the device. */
export function scopeSimctlArgsForDevice(
  device: DeviceInfo,
  args: readonly string[],
): ScopedSimctlArgs {
  return scopeSimctlArgs(simulatorAddressFor(device).simulatorSetPath, args);
}

export function buildSimctlArgsForAddress(
  address: SimulatorAddress,
  args: readonly string[],
): ScopedSimctlCommand {
  return simctlCommand(scopeSimctlArgs(address.simulatorSetPath, args));
}

export function buildSimctlArgsForDevice(
  device: DeviceInfo,
  args: readonly string[],
): ScopedSimctlCommand {
  return buildSimctlArgsForAddress(simulatorAddressFor(device), args);
}

export function runSimctlForDevice(
  device: DeviceInfo,
  args: readonly string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return runXcrun(buildSimctlArgsForDevice(device, args), options);
}

type SimctlListedDevice = { udid?: string; state?: string };

/** The runtime-keyed device lists of `simctl list devices -j` output; throws unless it is a JSON object. */
export function readSimctlDevicesByRuntime(stdout: string): Record<string, SimctlListedDevice[]> {
  const payload = JSON.parse(stdout) as { devices?: Record<string, SimctlListedDevice[]> };
  return payload.devices ?? {};
}

/** The listed state of one simulator; null when the listing is unreadable or omits the device. */
export function readSimctlDeviceState(stdout: string, udid: string): string | null {
  try {
    for (const devices of Object.values(readSimctlDevicesByRuntime(stdout))) {
      const match = devices.find((entry) => entry.udid === udid);
      if (match) return match.state ?? null;
    }
    return null;
  } catch {
    return null;
  }
}
