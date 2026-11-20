import browserstack from '@agent-device/browserstack';
import { createPluginHost } from '@agent-device/plugins/host';
import { createCloudWebDriverRuntime } from '@agent-device/provider-webdriver/plugin';

export const BROWSERSTACK_PROVIDER = 'browserstack';

/** The WebDriver descriptor the BrowserStack plugin's `setup` builds from `env`, as `clientVersion` hosted. */
export async function browserStackWebDriver(env: Record<string, string>, clientVersion: string) {
  const [contribution] = browserstack().contributes;
  if (contribution.kind !== 'provider') throw new Error('BrowserStack sets up a provider');
  const setup = await contribution.setup({
    ...createPluginHost({ env, cwd: '/' }, undefined),
    clientVersion,
  });
  if (!('webDriver' in setup)) throw new Error('BrowserStack sets up a WebDriver descriptor');
  return setup.webDriver;
}

/** A BrowserStack runtime composed the way the registry composes a plugin's WebDriver descriptor. */
export async function createBrowserStackRuntime(options: {
  env: Record<string, string>;
  clientVersion: string;
}) {
  return await createCloudWebDriverRuntime({
    ...(await browserStackWebDriver(options.env, options.clientVersion)),
    clientVersion: options.clientVersion,
  });
}
