import { awsDeviceFarmProvider } from './aws-device-farm-provider.ts';
import { browserStackProvider } from './browserstack-provider.ts';
import type {
  BundledCloudWebDriverProvider,
  CloudWebDriverProviderHost,
} from './provider-plugin.ts';
import { createCloudWebDriverRuntime, type CloudWebDriverRuntime } from './runtime.ts';

export { CLOUD_WEBDRIVER_PROVIDERS } from './providers.ts';
export type { RunHostCommand } from './dependencies.ts';
export type {
  BundledCloudWebDriverProvider,
  CloudWebDriverConnection,
  CloudWebDriverProviderHost,
} from './provider-plugin.ts';
export type { CloudWebDriverRuntime } from './runtime.ts';

/**
 * The hosted WebDriver providers agent-device ships. Each presents the shape an installed plugin
 * returns, so moving one out of the bundle is a packaging change, not a provider rewrite.
 */
export const BUNDLED_CLOUD_WEBDRIVER_PROVIDERS: readonly BundledCloudWebDriverProvider[] =
  Object.freeze([browserStackProvider, awsDeviceFarmProvider]);

export function bundledCloudWebDriverProvider(
  provider: string | undefined,
): BundledCloudWebDriverProvider | undefined {
  return BUNDLED_CLOUD_WEBDRIVER_PROVIDERS.find(
    (bundled) => bundled.declaration.provider === provider,
  );
}

/** One runtime per bundled provider, composed the way an installed WebDriver plugin is. */
export function createBundledCloudWebDriverRuntimes(
  host: CloudWebDriverProviderHost,
): CloudWebDriverRuntime[] {
  return BUNDLED_CLOUD_WEBDRIVER_PROVIDERS.map((bundled) =>
    createCloudWebDriverRuntime({
      ...bundled.create(host).webDriver,
      clientVersion: host.clientVersion,
    }),
  );
}
