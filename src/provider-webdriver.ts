import {
  bundledCloudWebDriverProvider,
  type CloudWebDriverConnection,
  type CloudWebDriverProviderHost,
} from '@agent-device/provider-webdriver';
import { runCmd } from '@agent-device/host-kit/command';
import { readVersion } from '@agent-device/host-kit/version';
import type { EnvMap } from '@agent-device/kernel/source-value';

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

/** The `connect` callbacks of a bundled provider, or undefined for any other provider name. */
export function bundledCloudWebDriverConnection(
  provider: string,
  env: EnvMap,
): CloudWebDriverConnection | undefined {
  return bundledCloudWebDriverProvider(provider)?.create(createBundledCloudWebDriverHost(env))
    .connection;
}
