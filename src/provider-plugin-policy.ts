import { AppError } from '@agent-device/kernel/errors';
import type { PluginConnection } from '@agent-device/plugins/connection';
import type { PluginLoadPolicy } from '@agent-device/plugins/load';
import type { CloudWebDriverProviderOptions } from '@agent-device/provider-webdriver/plugin';
import {
  CLOUD_WEBDRIVER_PROVIDERS,
  type CloudWebDriverKnownProviderName,
} from '@agent-device/provider-webdriver/providers';

/** The one list of provider ids plugins cannot claim: connect routes and bundled runtimes. */
export const RESERVED_PLUGIN_PROVIDERS: readonly (
  | 'cloud'
  | 'proxy'
  | 'limrun'
  | CloudWebDriverKnownProviderName
)[] = ['cloud', 'proxy', ...Object.values(CLOUD_WEBDRIVER_PROVIDERS), 'limrun'];

type WebDriverFactoryResult = {
  webDriver: CloudWebDriverProviderOptions;
  connection?: PluginConnection;
};

/**
 * The policy every plugin load, connection and installation in this process runs under. The
 * WebDriver runtime is evaluated only for a plugin that returns `{ webDriver }`.
 */
export const PROVIDER_PLUGIN_POLICY: PluginLoadPolicy = Object.freeze({
  reservedProviders: RESERVED_PLUGIN_PROVIDERS,
  adaptFactoryResult: async (result, { plugin, host }) => {
    if (typeof result !== 'object' || result === null || !('webDriver' in result)) return undefined;
    const { webDriver, connection } = result as WebDriverFactoryResult;
    if (webDriver?.provider !== plugin.provider) {
      throw new AppError(
        'INVALID_ARGS',
        `WebDriver plugin provider does not match its declaration: ${plugin.name}`,
      );
    }
    const { createCloudWebDriverRuntime } = await import('@agent-device/provider-webdriver/plugin');
    const runtime = await createCloudWebDriverRuntime({
      ...webDriver,
      clientVersion: host.clientVersion,
    });
    return { runtime, platformModule: runtime.platformRuntimeModule, connection };
  },
});
