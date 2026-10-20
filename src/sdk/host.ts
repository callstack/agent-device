import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { withCommandHost } from '@agent-device/host-kit/command';

/** Released SDK defaults removed in 0.22 (#3759). */
export function captureSdkHost(): HostEnvironment {
  return captureHostEnvironment(process);
}

export async function withSdkHost<T>(task: () => Promise<T>): Promise<T> {
  return await withCommandHost({ host: captureSdkHost(), requestEnv: undefined }, task);
}
