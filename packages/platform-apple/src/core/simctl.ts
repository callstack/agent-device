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

/**
 * `simctl list -j` over one simulator set; `undefined` lists the default set. The unfiltered
 * listing carries devices together with the device types and runtimes that describe them.
 */
export function simctlListInventoryArgs(simulatorSetPath: string | undefined): ScopedSimctlArgs {
  return scopeSimctlArgs(simulatorSetPath, ['list', '-j']);
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

type SimctlListedDevice = { udid?: string; state?: string; name?: string };

/** The runtime-keyed device lists of `simctl list devices -j` output; throws unless it is a JSON object. */
export function readSimctlDevicesByRuntime(stdout: string): Record<string, SimctlListedDevice[]> {
  const payload = JSON.parse(stdout) as { devices?: Record<string, SimctlListedDevice[]> };
  return payload.devices ?? {};
}

/**
 * `simctl list devices booted -j` scoped to one simulator set; `undefined` lists the default set.
 * A caller proving a name is unique across the sets it can see runs this per set.
 */
export function simctlListBootedArgsForSet(simulatorSetPath: string | undefined): ScopedSimctlArgs {
  return scopeSimctlArgs(simulatorSetPath, ['list', 'devices', 'booted', '-j']);
}

/**
 * The booted simulator display names of one `simctl list devices booted -j` payload; throws when
 * the stdout is not the listing JSON, so a caller can tell an unreadable listing from an empty one.
 */
export function readSimctlBootedNames(stdout: string): string[] {
  return Object.values(readSimctlDevicesByRuntime(stdout))
    .flat()
    .filter((entry) => entry.state === 'Booted')
    .map((entry) => entry.name ?? '');
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

/**
 * The literal `simctl get_app_container` prints on stdout when the app is installed but owns no
 * container in the requested domain — a system app has no `data` container — while still exiting 0.
 * It is the tool's own "no container" answer, not a path, so callers must never treat it as one.
 */
const SIMCTL_NULL_CONTAINER_PATH = '(null)';

/**
 * The container path `simctl get_app_container` printed, or `undefined` when it answered that no
 * container exists: an empty stdout or the `(null)` sentinel on an otherwise-successful exit. One
 * reader for every caller that turns that stdout into a host path, so the sentinel cannot be
 * mistaken for a directory at one site and handled at another.
 */
export function readSimctlContainerPath(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === SIMCTL_NULL_CONTAINER_PATH) return undefined;
  return trimmed;
}
