import { awsDeviceFarmProvider } from './aws-device-farm-provider.ts';
import { browserStackProvider } from './browserstack-provider.ts';
import type { BundledCloudWebDriverProvider } from './provider-plugin.ts';

export type { RunHostCommand } from './dependencies.ts';
export type {
  BundledCloudWebDriverProvider,
  CloudWebDriverConnection,
  CloudWebDriverProviderHost,
} from './provider-plugin.ts';

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
