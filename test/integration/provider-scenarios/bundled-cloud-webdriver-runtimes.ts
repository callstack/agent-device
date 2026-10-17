import {
  BUNDLED_CLOUD_WEBDRIVER_PROVIDERS,
  type CloudWebDriverProviderHost,
} from '@agent-device/provider-webdriver';
import { createCloudWebDriverRuntime } from '@agent-device/provider-webdriver/plugin';

/** One runtime per bundled provider, composed the way the registry composes a WebDriver descriptor. */
export async function createBundledCloudWebDriverRuntimes(host: CloudWebDriverProviderHost) {
  return await Promise.all(
    BUNDLED_CLOUD_WEBDRIVER_PROVIDERS.map(
      async (bundled) =>
        await createCloudWebDriverRuntime({
          ...bundled.create(host).webDriver,
          clientVersion: host.clientVersion,
        }),
    ),
  );
}
