import type { ProviderPluginHost } from 'agent-device/plugins';
import { createSauceLabsConnection } from './connection.ts';
import { createSauceLabsWebDriver } from './saucelabs-webdriver.ts';

/** The version 1 plugin entry, kept so hosts without the version 2 contract still load this package. */
export default function sauceLabsPlugin(host: ProviderPluginHost) {
  return { webDriver: createSauceLabsWebDriver(host), connection: createSauceLabsConnection(host) };
}
