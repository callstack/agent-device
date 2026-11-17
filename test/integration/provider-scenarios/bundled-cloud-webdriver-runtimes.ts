import { createAwsDeviceFarmRuntime } from './aws-runtime.ts';
import type { RunHostCommand } from '@agent-device/plugins/host';

export async function createBundledCloudWebDriverRuntimes(host: {
  env: Record<string, string>;
  clientVersion: string;
  runHostCommand: RunHostCommand;
}) {
  return [await createAwsDeviceFarmRuntime(host)];
}
