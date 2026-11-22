import path from 'node:path';
import type { PluginConnection, ProviderAgentDevicePlugin } from 'agent-device/plugins';
import type { DeviceProviderPluginHost } from 'agent-device/plugins/device-host';
import { limrunCredentialDeclaration, requireLimrunCredentials } from './credentials.ts';
import { LIMRUN_CONNECTION_CAPABILITIES, LIMRUN_PROVIDER } from './device.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

export type LimrunPluginOptions = Readonly<{
  /**
   * Builds the runtime's host and platform adapters for one setup host. Defaults to the adapters
   * the host's own capabilities answer.
   */
  createDependencies?(
    host: DeviceProviderPluginHost,
  ): LimrunRuntimeDependencies | Promise<LimrunRuntimeDependencies>;
}>;

const LIMRUN_CONNECTION: PluginConnection = {
  capabilities: LIMRUN_CONNECTION_CAPABILITIES,
  // The connect callbacks load when the first `connect` runs them, so a process that only lists or
  // fingerprints this provider evaluates none of them.
  resolve: async (context) =>
    await (await import('./connection.ts')).createLimrunConnection().resolve(context),
  verify: async (context) =>
    await (await import('./connection.ts')).createLimrunConnection().verify(context),
};

/**
 * Limrun as a version 3 plugin: instances are rented from the Limrun API and driven through their
 * own ADB tunnel or Simulator bridge.
 *
 * The credentials are read from the setup host's environment, so the plugin declares exactly the
 * variables it reads there, narrowed per lease backend. Only this module's declaration is needed to
 * list, fingerprint, or route a `connect` to the provider: the connection's flags and credential
 * reading, the runtime, and its host adapters all load in the path that asks for them.
 */
export function limrunPlugin(options: LimrunPluginOptions = {}): ProviderAgentDevicePlugin {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'provider',
        provider: LIMRUN_PROVIDER,
        credentials: limrunCredentialDeclaration(),
        connection: LIMRUN_CONNECTION,
        setup: async (host: DeviceProviderPluginHost) => {
          const credentials = requireLimrunCredentials(host.env);
          const [register, dependencies] = await Promise.all([
            import('./runtime.ts'),
            options.createDependencies
              ? options.createDependencies(host)
              : import('./host-dependencies.ts').then((module) =>
                  module.createLimrunRuntimeDependencies(host),
                ),
          ]);
          return register.createLimrunRuntime(
            {
              ...credentials,
              ...(host.stateDir === undefined
                ? {}
                : {
                    // HAR captures land beside the session files, under the daemon's state dir.
                    networkHarDir: path.join(host.stateDir, 'network-har'),
                  }),
            },
            dependencies,
            { includePlatformModule: true },
          );
        },
      },
    ],
  };
}
