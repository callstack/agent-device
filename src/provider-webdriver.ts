import {
  BUNDLED_CLOUD_WEBDRIVER_PROVIDERS,
  bundledCloudWebDriverProvider,
  createBundledCloudWebDriverRuntimes,
  type CloudWebDriverConnection,
  type CloudWebDriverProviderHost,
  type CloudWebDriverRuntime,
} from '@agent-device/provider-webdriver';
import { runCmd } from '@agent-device/host-kit/command';
import { readVersion } from '@agent-device/host-kit/version';
import type { EnvMap } from '@agent-device/kernel/source-value';

/** The provider IDs the daemon composes without a plugin; each is reserved from plugins. */
export const BUNDLED_CLOUD_WEBDRIVER_PROVIDER_IDS: readonly string[] =
  BUNDLED_CLOUD_WEBDRIVER_PROVIDERS.map((bundled) => bundled.declaration.provider);

/** What this process hands a bundled provider: the plugin host shape plus a host-command runner. */
export function createBundledCloudWebDriverHost(env: EnvMap): CloudWebDriverProviderHost {
  return {
    env,
    clientVersion: readVersion(),
    runHostCommand: async (command, args) => {
      const result = await runCmd(command, [...args], {
        maxBuffer: 10 * 1024 * 1024,
        timeoutMs: 30_000,
      });
      return { stdout: result.stdout };
    },
  };
}

export function bundledCloudWebDriverRuntimes(env: EnvMap): CloudWebDriverRuntime[] {
  return createBundledCloudWebDriverRuntimes(createBundledCloudWebDriverHost(env));
}

/** The `connect` callbacks of a bundled provider, or undefined for any other provider name. */
export function bundledCloudWebDriverConnection(
  provider: string,
  env: EnvMap,
): CloudWebDriverConnection | undefined {
  return bundledCloudWebDriverProvider(provider)?.create(createBundledCloudWebDriverHost(env))
    .connection;
}
