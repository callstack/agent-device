import type { AgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';
import { TESTMU_CONNECTION } from './connection.ts';
import testMuV1Plugin from './plugin.ts';

export type TestmuOptions = {
  /** Used instead of `LT_USERNAME` and `LT_ACCESS_KEY` when set. */
  credentials?: { username: string; accessKey: string };
};

/**
 * TestMu AI as a plugin. The credentials come from `options.credentials`, with the
 * `LT_USERNAME` and `LT_ACCESS_KEY` environment variables as the fallback; credentials passed as
 * options are not part of the environment the daemon fingerprints.
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
  return {
    apiVersion: 2,
    provider: 'testmu',
    credentials: { variables: credentials ? [] : ['LT_USERNAME', 'LT_ACCESS_KEY'] },
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
