import path from 'node:path';
import type { AgentDevicePlugin } from '@agent-device/plugins/contract';
import type { ProviderPluginHost } from '@agent-device/plugins/host';
import { AppError } from '@agent-device/kernel/errors';
import {
  limrunCredentialDeclaration,
  readLimrunCredentials,
  type LimrunCredentials,
} from './credentials.ts';
import { LIMRUN_PROVIDER } from './device.ts';
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
 * Limrun as a version 2 plugin: instances are rented from the Limrun API and driven through their
 * own ADB tunnel or Simulator bridge.
 *
 * The credentials are read from the setup host's environment, so the plugin declares exactly the
 * variables it reads there, narrowed per lease backend. Only this module's declaration is needed to
 * list or fingerprint the provider: the runtime and its host adapters load in `setup`.
 */
export function limrunPlugin(options: LimrunPluginOptions): AgentDevicePlugin {
  const { createDependencies, stateDir } = options;
  return {
    apiVersion: 2,
    provider: LIMRUN_PROVIDER,
    credentials: limrunCredentialDeclaration(),
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
  };
}

/**
 * The credentials this host's environment holds, refusing the shapes a runtime cannot act on:
 * nothing at all, or an instance set missing one of its variables.
 */
function requireLimrunCredentials(env: Record<string, string | undefined>): LimrunCredentials {
  const credentials = readLimrunCredentials(env);
  if (credentials) return credentials;
  throw new AppError(
    'INVALID_ARGS',
    'Limrun requires LIMRUN_API_KEY, or an instance variable set.',
    {
      reason: 'missing_provider_credentials',
      hint: 'Set LIMRUN_API_KEY for the account, or the full LIM_IOS_INSTANCE_* or LIM_ANDROID_INSTANCE_* set for an existing instance.',
    },
  );
}
