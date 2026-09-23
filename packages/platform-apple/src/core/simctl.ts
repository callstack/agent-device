import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { type ExecOptions, type ExecResult } from '@agent-device/host-kit/command';
import { resolveIosSimulatorDeviceSetPath } from '@agent-device/kernel/device-isolation';
import { runXcrun } from './tool-provider.ts';

type SimctlArgsOptions = {
  simulatorSetPath?: string;
};

/** Arguments that follow the `simctl` tool name, scoped to the simulator set when one is given. */
export function scopeSimctlArgs(
  args: readonly string[],
  options: SimctlArgsOptions = {},
): string[] {
  const simulatorSetPath = resolveIosSimulatorDeviceSetPath(options.simulatorSetPath);
  if (!simulatorSetPath) return [...args];
  return ['--set', simulatorSetPath, ...args];
}

/** Arguments that follow the `simctl` tool name, scoped to the simulator set holding the device. */
export function scopeSimctlArgsForDevice(device: DeviceInfo, args: readonly string[]): string[] {
  if (!isIosFamily(device) || device.kind !== 'simulator') return [...args];
  return scopeSimctlArgs(args, { simulatorSetPath: device.simulatorSetPath });
}

export function buildSimctlArgs(
  args: readonly string[],
  options: SimctlArgsOptions = {},
): string[] {
  return ['simctl', ...scopeSimctlArgs(args, options)];
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
