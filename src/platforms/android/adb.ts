import type { DeviceInfo } from '../../kernel/device.ts';
import {
  resolveAndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
} from './adb-executor.ts';

export { sleep } from '../../utils/timeouts.ts';

export async function runAndroidAdb(
  device: DeviceInfo,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await resolveAndroidAdbExecutor(device)(args, options);
}

export function androidDeviceForSerial(deviceId: string): DeviceInfo {
  return {
    platform: 'android',
    id: deviceId,
    name: deviceId,
    kind: deviceId.startsWith('emulator-') ? 'emulator' : 'device',
    booted: true,
  };
}

export function isClipboardShellUnsupported(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return (
    haystack.includes('no shell command implementation') || haystack.includes('unknown command')
  );
}
