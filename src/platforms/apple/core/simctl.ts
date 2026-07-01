import { isIosFamily, type DeviceInfo } from '../../../kernel/device.ts';
import type { ExecOptions, ExecResult } from '../../../utils/exec.ts';
import { resolveIosSimulatorDeviceSetPath } from '../../../utils/device-isolation.ts';
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
