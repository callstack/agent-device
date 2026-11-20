import type { ProviderAgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';
import { HOSTED_WEBDRIVER_CONNECTION } from '@agent-device/provider-webdriver/providers';
import { BROWSERSTACK_CREDENTIAL_VARIABLES } from './providers.ts';

export type BrowserStackOptions = {
  /** Each supplied key replaces its environment variable; omitted keys use the environment. */
  credentials?: { username?: string; accessKey?: string };
};

/**
 * BrowserStack as a plugin. The credentials come from `options.credentials`, with the
 * `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` environment variables as the fallback for
 * each key the options leave out. The plugin declares only the variables it reads from the
 * environment; credentials passed as options are not part of the environment the daemon
 * fingerprints.
 */
function browserstack(options: BrowserStackOptions = {}): ProviderAgentDevicePlugin {
  const { credentials } = options;
  const withCredentials = (host: ProviderPluginHost): ProviderPluginHost =>
    credentials
      ? {
          ...host,
          // A key the caller left out falls back to the environment instead of shadowing it.
          env: {
            ...host.env,
            ...(credentials.username !== undefined
              ? { [BROWSERSTACK_CREDENTIAL_VARIABLES.username]: credentials.username }
              : {}),
            ...(credentials.accessKey !== undefined
              ? { [BROWSERSTACK_CREDENTIAL_VARIABLES.accessKey]: credentials.accessKey }
              : {}),
          },
        }
      : host;
  // Only the variables the options do not supply come from the environment, so only those are
  // part of the credential fingerprint.
  const environmentVariables = [
    ...(credentials?.username !== undefined ? [] : [BROWSERSTACK_CREDENTIAL_VARIABLES.username]),
    ...(credentials?.accessKey !== undefined ? [] : [BROWSERSTACK_CREDENTIAL_VARIABLES.accessKey]),
  ];
  // The connection code loads when `connect` runs it, so importing the package for its declaration
  // stays small. The loader keeps the credentials it was given on the host it builds.
  const loadBrowserStackConnection = async (host: ProviderPluginHost) =>
    (await import('./connection.ts')).createBrowserStackConnection(withCredentials(host));
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'provider',
        provider: 'browserstack',
        credentials: { variables: environmentVariables },
        connection: {
          capabilities: { ...HOSTED_WEBDRIVER_CONNECTION },
          resolve: async (context) =>
            (await loadBrowserStackConnection(context.host)).resolve(context),
          verify: async (context) =>
            await (await loadBrowserStackConnection(context.host)).verify(context),
        },
        setup: async (host) => ({
          webDriver: (await import('./browserstack-webdriver.ts')).createBrowserStackWebDriver(
            withCredentials(host),
          ),
        }),
      },
    ],
  };
}

export { browserstack as default };
