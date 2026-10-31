import type { AgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';
import { REVYL_PROVIDER } from './device.ts';
import { REVYL_API_KEY_VARIABLE, REVYL_API_URL_VARIABLE } from './credentials.ts';
import { setupRevylPlugin } from './plugin-setup.ts';

export type RevylPluginOptions = {
  /** Used instead of `REVYL_API_KEY` when set. */
  apiKey?: string;
  /** Used instead of `REVYL_API_URL` when set; the public backend is used when neither is set. */
  apiUrl?: string;
};

/**
 * Revyl cloud devices as a plugin: a device is rented from the Revyl backend and driven through its
 * device-proxy actions, with no WebDriver or Appium session in between.
 *
 * The credentials come from `options`, with `REVYL_API_KEY` and the optional `REVYL_API_URL`
 * environment variables as the fallback. The plugin declares only the variables it reads from the
 * environment: a credential passed as an option is not part of the environment the daemon
 * fingerprints.
 */
function revyl(options: RevylPluginOptions = {}): AgentDevicePlugin {
  // Each option replaces its own variable and nothing else: an `apiUrl` with no `apiKey` still has
  // the key read from the environment, and a `apiKey` with no `apiUrl` still reads the URL there.
  const overridden: Record<string, string> = {};
  if (options.apiKey !== undefined) overridden[REVYL_API_KEY_VARIABLE] = options.apiKey;
  if (options.apiUrl !== undefined) overridden[REVYL_API_URL_VARIABLE] = options.apiUrl;
  const withCredentials = (host: ProviderPluginHost): ProviderPluginHost =>
    Object.keys(overridden).length === 0 ? host : { ...host, env: { ...host.env, ...overridden } };
  // Only a variable this plugin still reads from the environment is declared: one the options carry
  // is not part of what the daemon fingerprints.
  const environmentVariables = [
    ...(options.apiKey === undefined ? [REVYL_API_KEY_VARIABLE] : []),
    ...(options.apiUrl === undefined ? [REVYL_API_URL_VARIABLE] : []),
  ];
  return {
    apiVersion: 2,
    provider: REVYL_PROVIDER,
    credentials: { variables: environmentVariables },
    connection: {
      capabilities: {
        leaseKind: 'direct-device-provider',
        requiresAppAttachment: false,
        requiresRemoteDaemon: false,
        supportsArtifacts: false,
        // Revyl installs the app as part of starting the device, so the app has to be known before the
        // lease exists and cannot be attached to a device that is already up.
        supportsDeferredAppSelection: false,
        supportsDirectPortReverse: false,
        usesCloudWebDriverLease: false,
      },
      resolve: (context) =>
        import('./connection.ts').then(({ createRevylConnection }) =>
          createRevylConnection(withCredentials(context.host)).resolve(context),
        ),
      verify: async (context) =>
        await (
          await import('./connection.ts')
        )
          .createRevylConnection(withCredentials(context.host))
          .verify(context),
    },
    setup: async (host) => await setupRevylPlugin(withCredentials(host)),
  };
}

export { revyl as default };
