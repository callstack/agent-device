import { AppError } from '@agent-device/kernel/errors';
import type { PluginRegistryPolicy } from '@agent-device/plugins/registry';
import type { CloudWebDriverRuntimeOptions } from '@agent-device/provider-webdriver/plugin';

/**
 * The policy every provider registry in this process runs under. A plugin that returns a
 * `{ webDriver }` descriptor gets the shared WebDriver engine, loaded only then.
 */
export const PROVIDER_PLUGIN_POLICY: PluginRegistryPolicy = Object.freeze({
  adaptWebDriver: async (descriptor, { clientVersion }) => {
    const options = readWebDriverOptions(descriptor);
    const { createCloudWebDriverRuntime } = await import('@agent-device/provider-webdriver/plugin');
    const runtime = await createCloudWebDriverRuntime({ ...options, clientVersion });
    return { runtime, platformModule: runtime.platformRuntimeModule };
  },
});

type WebDriverDescriptorOptions = Omit<CloudWebDriverRuntimeOptions, 'clientVersion'>;

/** Refuses a descriptor that lacks what the engine needs, so a broken plugin fails at startup and not at the first lease. */
function readWebDriverOptions(descriptor: object): WebDriverDescriptorOptions {
  const fields = descriptor as Partial<Record<keyof WebDriverDescriptorOptions, unknown>>;
  const endpoint = fields.endpoint;
  const valid =
    typeof fields.provider === 'string' &&
    (typeof endpoint === 'string' || endpoint instanceof URL) &&
    (fields.platform === 'android' || fields.platform === 'ios') &&
    typeof fields.deviceName === 'string' &&
    typeof fields.profileFields === 'object' &&
    fields.profileFields !== null;
  if (!valid) {
    throw new AppError(
      'INVALID_ARGS',
      'A WebDriver plugin must provide provider, endpoint, platform, deviceName and profileFields',
      { reason: 'invalid_plugin' },
    );
  }
  return descriptor as WebDriverDescriptorOptions;
}
