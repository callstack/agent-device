import path from 'node:path';
import type { AgentDevicePlugin } from '@agent-device/plugins/contract';
import type { ProviderPluginHost } from '@agent-device/plugins/host';
import { limrunCredentialDeclaration, requireLimrunCredentials } from './credentials.ts';
import { LIMRUN_CONNECTION_CAPABILITIES, LIMRUN_PROVIDER } from './device.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

export type LimrunPluginOptions = Readonly<{
  /**
   * Builds the runtime's host and platform adapters for one setup host. The provider names what a
   * runtime needs; whoever composes the host supplies how those needs are served, so the runtime
   * graph stays free of platform implementation.
   */
  createDependencies(
    host: ProviderPluginHost,
  ): LimrunRuntimeDependencies | Promise<LimrunRuntimeDependencies>;
  /**
   * The daemon's own state directory. Each lease's `--provider-network-logs` HAR file is written
   * beside the session files under it; without it the capture is unavailable.
   */
  stateDir?: string;
}>;

/**
 * Limrun as a version 3 plugin: instances are rented from the Limrun API and driven through their
 * own ADB tunnel or Simulator bridge.
 *
 * The credentials are read from the setup host's environment, so the plugin declares exactly the
 * variables it reads there, narrowed per lease backend. Only this module's declaration is needed to
 * list, fingerprint, or route a `connect` to the provider: the connection's flags and credential
 * reading, the runtime, and its host adapters all load in the path that asks for them.
 */
export function limrunPlugin(options: LimrunPluginOptions): AgentDevicePlugin {
  const { createDependencies, stateDir } = options;
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'provider',
        provider: LIMRUN_PROVIDER,
        credentials: limrunCredentialDeclaration(),
        // The connect callbacks are the provider's own and load when the first `connect` runs them,
        // so a process that only lists or fingerprints this provider evaluates none of them.
        connection: {
          capabilities: LIMRUN_CONNECTION_CAPABILITIES,
          resolve: async (context) =>
            await (await import('./connection.ts')).createLimrunConnection().resolve(context),
          verify: async (context) =>
            await (await import('./connection.ts')).createLimrunConnection().verify(context),
        },
        setup: async (host) => {
          const credentials = requireLimrunCredentials(host.env);
          const [register, dependencies] = await Promise.all([
            import('./runtime.ts'),
            Promise.resolve(createDependencies(host)),
          ]);
          return register.createLimrunRuntime(
            {
              ...credentials,
              ...(stateDir === undefined
                ? {}
                : {
                    // HAR captures land beside the session files, under the daemon's own state dir.
                    networkHarDir: path.join(stateDir, 'network-har'),
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
