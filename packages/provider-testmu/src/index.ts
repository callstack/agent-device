import type { AgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';
import { TESTMU_CONNECTION } from './connection.ts';
import testMuV1Plugin from './plugin.ts';

export type TestmuOptions = {
  /** Used instead of `LT_USERNAME` and `LT_ACCESS_KEY` when set. */
  credentials?: { username: string; accessKey: string };
};

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
      capabilities: TESTMU_CONNECTION,
      resolve: (context) =>
        testMuV1Plugin(withCredentials(context.host)).connection.resolve(context),
      verify: async (context) =>
        await testMuV1Plugin(withCredentials(context.host)).connection.verify(context),
    },
    setup: (host) => ({ webDriver: testMuV1Plugin(withCredentials(host)).webDriver }),
  };
}

export { testmu as default };
