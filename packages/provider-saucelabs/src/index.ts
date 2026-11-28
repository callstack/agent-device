import type { AgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';

export type SauceLabsOptions = {
  /** Used instead of `SAUCE_USERNAME` and `SAUCE_ACCESS_KEY` when set. */
  credentials?: { username: string; accessKey: string };
};

// The connection and WebDriver code load when they are first used, so importing the package for its
// declaration stays small.
async function loadConnection(host: ProviderPluginHost) {
  return (await import('./connection.ts')).createSauceLabsConnection(host);
}

/**
 * Sauce Labs as a plugin. The credentials come from `options.credentials`, with the
 * `SAUCE_USERNAME` and `SAUCE_ACCESS_KEY` environment variables as the fallback for each key the
 * options leave out. The data center always comes from `SAUCE_REGION`. The plugin declares only the
 * variables it reads from the environment; credentials passed as options are not part of the
 * environment the daemon fingerprints.
 */
function saucelabs(options: SauceLabsOptions = {}): AgentDevicePlugin {
  const { credentials } = options;
  const withCredentials = (host: ProviderPluginHost): ProviderPluginHost =>
    credentials
      ? {
          ...host,
          // A key the caller left out falls back to the environment instead of shadowing it.
          env: {
            ...host.env,
            ...(credentials.username ? { SAUCE_USERNAME: credentials.username } : {}),
            ...(credentials.accessKey ? { SAUCE_ACCESS_KEY: credentials.accessKey } : {}),
          },
        }
      : host;
  // Only the variables the options do not supply come from the environment, so only those are
  // part of the credential fingerprint. The region selects where the credentials are sent, so a
  // daemon started for another data center is caught the same way.
  const environmentVariables = [
    ...(credentials?.username ? [] : ['SAUCE_USERNAME']),
    ...(credentials?.accessKey ? [] : ['SAUCE_ACCESS_KEY']),
    'SAUCE_REGION',
  ];
  return {
    apiVersion: 2,
    provider: 'saucelabs',
    credentials: { variables: environmentVariables },
    connection: {
      capabilities: {
        leaseKind: 'direct-device-provider',
        requiresAppAttachment: false,
        requiresRemoteDaemon: false,
        supportsArtifacts: true,
        supportsDeferredAppSelection: false,
        supportsDirectPortReverse: false,
        usesCloudWebDriverLease: true,
      },
      resolve: async (context) =>
        (await loadConnection(withCredentials(context.host))).resolve(context),
      verify: async (context) =>
        await (await loadConnection(withCredentials(context.host))).verify(context),
    },
    setup: async (host) => ({
      webDriver: (await import('./saucelabs-webdriver.ts')).createSauceLabsWebDriver(
        withCredentials(host),
      ),
    }),
  };
}

export { saucelabs as default };
