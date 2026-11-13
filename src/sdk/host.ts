import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { withCommandHost } from '@agent-device/host-kit/command';

export async function withSdkHost<T>(host: HostEnvironment, task: () => Promise<T>): Promise<T> {
  return await withCommandHost({ host, requestEnv: {} }, task);
}
