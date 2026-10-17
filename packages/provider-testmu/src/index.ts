import type { AgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';
import manifest from '../package.json' with { type: 'json' };

type ConnectionCapabilities = NonNullable<AgentDevicePlugin['connection']>['capabilities'];

export type TestmuOptions = {
  /** Used instead of `LT_USERNAME` and `LT_ACCESS_KEY` when set. */
  credentials?: { username: string; accessKey: string };
};

// The connection and WebDriver code load when they are first used, so importing the package for its
// declaration stays small.
async function loadConnection(host: ProviderPluginHost) {
  return (await import('./connection.ts')).createTestMuConnection(host);
}

/**
 * TestMu AI as a plugin. The credentials come from `options.credentials`, with the
 * `LT_USERNAME` and `LT_ACCESS_KEY` environment variables as the fallback for each key the options
 * leave out. The plugin declares only the variables it reads from the environment; credentials passed
 * as options are not part of the environment the daemon fingerprints.
 */
function testmu(options: TestmuOptions = {}): AgentDevicePlugin {
  const { credentials } = options;
  const withCredentials = (host: ProviderPluginHost): ProviderPluginHost =>
    credentials
      ? {
          ...host,
          // A key the caller left out falls back to the environment instead of shadowing it.
          env: {
            ...host.env,
            ...(credentials.username ? { LT_USERNAME: credentials.username } : {}),
            ...(credentials.accessKey ? { LT_ACCESS_KEY: credentials.accessKey } : {}),
          },
        }
      : host;
  // Only the variables the options do not supply come from the environment, so only those are
  // part of the credential fingerprint.
  const environmentVariables = [
    ...(credentials?.username ? [] : ['LT_USERNAME']),
    ...(credentials?.accessKey ? [] : ['LT_ACCESS_KEY']),
  ];
  return {
    apiVersion: 2,
    provider: 'testmu',
    credentials: { variables: environmentVariables },
    connection: {
      // The declaration hosts without the version 2 contract read from package.json; the registry
      // validates it when the plugin loads.
      capabilities: manifest.agentDevicePlugin.connection as ConnectionCapabilities,
      resolve: async (context) =>
        (await loadConnection(withCredentials(context.host))).resolve(context),
      verify: async (context) =>
        await (await loadConnection(withCredentials(context.host))).verify(context),
    },
    setup: async (host) => ({
      webDriver: (await import('./testmu-webdriver.ts')).createTestMuWebDriver(
        withCredentials(host),
      ),
    }),
  };
}

export { testmu as default };
