import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { type ExecOptions, type ExecResult } from '@agent-device/host-kit/command';
import { resolveIosSimulatorDeviceSetPath } from '@agent-device/kernel/device-isolation';
import type { ScopedSimctlArgs } from '@agent-device/contracts/platform-runtime-host';
import { runXcrun } from './tool-provider.ts';

/** The set of a simctl call that names no device; `undefined` names the default set on purpose. */
export type SimulatorSetScope = Readonly<{ simulatorSetPath: string | undefined }>;

declare const simulatorAddress: unique symbol;
/** A simulator udid with the set that holds it; minted only from a DeviceInfo. */
export type SimulatorAddress = Readonly<{ udid: string; simulatorSetPath: string | undefined }> & {
  readonly [simulatorAddress]: true;
};

export function simulatorAddressFor(device: DeviceInfo): SimulatorAddress {
  const simulatorSetPath =
    isIosFamily(device) && device.kind === 'simulator' ? device.simulatorSetPath : undefined;
  return Object.freeze({ udid: device.id, simulatorSetPath }) as SimulatorAddress;
}

/** Arguments that follow the `simctl` tool name for a call that names no device. */
export function scopeSimctlArgs(
  args: readonly string[],
  scope: SimulatorSetScope,
): ScopedSimctlArgs {
  const simulatorSetPath = resolveIosSimulatorDeviceSetPath(scope.simulatorSetPath);
  const scoped = simulatorSetPath ? ['--set', simulatorSetPath, ...args] : [...args];
  return Object.freeze(scoped) as ScopedSimctlArgs;
}

/** Arguments that follow the `simctl` tool name, scoped to the set holding the addressed simulator. */
export function scopeSimctlArgsForAddress(
  address: SimulatorAddress,
  args: readonly string[],
): ScopedSimctlArgs {
  return scopeSimctlArgs(args, { simulatorSetPath: address.simulatorSetPath });
}

/** Arguments that follow the `simctl` tool name, scoped to the simulator set holding the device. */
export function scopeSimctlArgsForDevice(
  device: DeviceInfo,
  args: readonly string[],
): ScopedSimctlArgs {
  return scopeSimctlArgsForAddress(simulatorAddressFor(device), args);
}

export function buildSimctlArgsForAddress(
  address: SimulatorAddress,
  args: readonly string[],
): string[] {
  return ['simctl', ...scopeSimctlArgsForAddress(address, args)];
}

export function buildSimctlArgsForDevice(device: DeviceInfo, args: readonly string[]): string[] {
  return ['simctl', ...scopeSimctlArgsForDevice(device, args)];
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
