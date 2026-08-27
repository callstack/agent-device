import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import type { ExecOptions, ExecResult } from '@agent-device/host-kit/exec';
import { resolveIosSimulatorDeviceSetPath } from '@agent-device/host-kit/fs';
import { runXcrun } from './tool-provider.ts';

type SimctlArgsOptions = {
  simulatorSetPath?: string;
};

export function buildSimctlArgs(args: string[], options: SimctlArgsOptions = {}): string[] {
  const simulatorSetPath = resolveIosSimulatorDeviceSetPath(options.simulatorSetPath);
  if (!simulatorSetPath) return ['simctl', ...args];
  return ['simctl', '--set', simulatorSetPath, ...args];
}

export function buildSimctlArgsForDevice(device: DeviceInfo, args: string[]): string[] {
  if (!isIosFamily(device) || device.kind !== 'simulator') {
    return ['simctl', ...args];
  }
  return buildSimctlArgs(args, { simulatorSetPath: device.simulatorSetPath });
}

export function runSimctlForDevice(
  device: DeviceInfo,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return runXcrun(buildSimctlArgsForDevice(device, args), options);
}
