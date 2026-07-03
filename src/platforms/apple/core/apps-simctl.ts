import type { DeviceInfo } from '../../../kernel/device.ts';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { runXcrun } from './tool-provider.ts';

export function simctlArgs(device: DeviceInfo, args: string[]): string[] {
  return buildSimctlArgsForDevice(device, args);
}

export function runSimctl(
  device: DeviceInfo,
  args: string[],
  options?: Parameters<typeof runXcrun>[1],
) {
  return runXcrun(simctlArgs(device, args), options);
}

export function isMissingAppErrorOutput(output: string): boolean {
  return (
    output.includes('not installed') ||
    output.includes('not found') ||
    output.includes('no such file')
  );
}
