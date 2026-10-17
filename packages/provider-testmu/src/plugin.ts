import type { ProviderPluginHost } from 'agent-device/plugins';
import { createTestMuConnection } from './connection.ts';
import { createTestMuWebDriver } from './testmu-webdriver.ts';

/** The version 1 plugin entry, kept so hosts without the version 2 contract still load this package. */
export default function testMuPlugin(host: ProviderPluginHost) {
  return { webDriver: createTestMuWebDriver(host), connection: createTestMuConnection(host) };
}
