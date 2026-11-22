import awsDeviceFarm from '@agent-device/aws-device-farm';
import { createPluginHost } from '@agent-device/plugins/host';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import type { RunHostCommand } from '@agent-device/plugins/host';

export const AWS_DEVICE_FARM_PROVIDER = 'aws-device-farm';

export async function createAwsDeviceFarmRuntime(options: {
  env: Record<string, string>;
  clientVersion: string;
  runHostCommand: RunHostCommand;
}) {
  const [contribution] = awsDeviceFarm().contributes;
  const { runtime } = await contribution.setup({
    ...(await createPluginHost({ env: options.env, cwd: '/' }, undefined)),
    clientVersion: options.clientVersion,
    runHostCommand: options.runHostCommand,
  });
  return runtime as ProviderDeviceRuntime & {
    platformRuntimeModule: PlatformRuntimeProviderModule;
  };
}
