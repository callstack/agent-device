import awsDeviceFarm from '@agent-device/aws-device-farm';
import { createPluginHost } from '@agent-device/plugins/host';
import { createCloudWebDriverRuntime } from '@agent-device/provider-webdriver/plugin';
import type { RunHostCommand } from '@agent-device/plugins/host';

export const AWS_DEVICE_FARM_PROVIDER = 'aws-device-farm';

/** The WebDriver descriptor the AWS Device Farm plugin's `setup` builds from `env`, as `clientVersion` hosted. */
async function awsDeviceFarmWebDriver(
  env: Record<string, string>,
  clientVersion: string,
  runHostCommand: RunHostCommand,
) {
  const setup = await awsDeviceFarm().setup({
    ...createPluginHost({ env, cwd: '/' }, undefined),
    clientVersion,
    runHostCommand,
  });
  if (!('webDriver' in setup)) throw new Error('AWS Device Farm sets up a WebDriver descriptor');
  return setup.webDriver;
}

/** An AWS Device Farm runtime composed the way the registry composes a plugin's WebDriver descriptor. */
export async function createAwsDeviceFarmRuntime(options: {
  env: Record<string, string>;
  clientVersion: string;
  runHostCommand: RunHostCommand;
}) {
  return await createCloudWebDriverRuntime({
    ...(await awsDeviceFarmWebDriver(options.env, options.clientVersion, options.runHostCommand)),
    clientVersion: options.clientVersion,
  });
}
