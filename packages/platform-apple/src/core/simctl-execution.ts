import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ExecResult } from '@agent-device/host-kit/command';
import { runXcrun, type AppleToolExecOptions } from './tool-provider.ts';
import { buildSimctlArgsForDevice } from './simctl.ts';

export function runSimctlForDevice(
  device: DeviceInfo,
  args: readonly string[],
  options?: AppleToolExecOptions,
): Promise<ExecResult> {
  return runXcrun(buildSimctlArgsForDevice(device, args), options);
}
