import type { AgentDevicePlugin, ProviderPluginHost } from 'agent-device/plugins';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import { REVYL_API_KEY_VARIABLE, REVYL_API_URL_VARIABLE } from './credentials.ts';

export type RevylPluginOptions = {
  /** Used instead of `REVYL_API_KEY` when set. */
  apiKey?: string;
  /** Used instead of `REVYL_API_URL` when set; the public backend is used when neither is set. */
  apiUrl?: string;
};

/** What `setup` builds: the runtime the host leases through, and the owner it binds devices with. */
export type RevylSetupResult = {
  runtime: ProviderDeviceRuntime;
  platformModule: PlatformRuntimeProviderModule;
};

// The runtime, connection, and owner code load when they are first used, so importing the package for
// its declaration stays inside the eager-closure budget a plugin's entry is held to.
async function createRuntime(host: ProviderPluginHost): Promise<RevylSetupResult> {
  const { requireRevylCredentials } = await import('./credentials.ts');
  const { createRevylRuntime } = await import('./runtime.ts');
  const credentials = requireRevylCredentials(host.env, 'Revyl');
  return createRevylRuntime(
    {
      apiKey: credentials.apiKey,
      ...(credentials.apiUrl === undefined ? {} : { backendUrl: credentials.apiUrl }),
      clientVersion: host.clientVersion,
    },
    { includePlatformModule: true },
  );
}

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
    provider: 'revyl',
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
    setup: async (host) => await createRuntime(withCredentials(host)),
  };
}

export { revyl as default };
