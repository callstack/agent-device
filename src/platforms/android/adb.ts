import type { DeviceInfo } from '@agent-device/kernel/device';
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

export { isAndroidClipboardShellUnsupported as isClipboardShellUnsupported } from '@agent-device/contracts/android-clipboard-support';
