import type { AgentDevicePlugin } from '@agent-device/plugins/contract';
import type { PluginCandidate } from '@agent-device/plugins/registry';
import { LIMRUN_ID } from './builtin-provider-ids.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import path from 'node:path';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  limrunCredentialDeclaration,
  readLimrunCredentials,
  type LimrunCredentials,
} from './provider-limrun-credentials.ts';

/**
 * The built-in providers as registry candidates, in the shape a plugin has. Their implementations
 * load only when a runtime is set up; a candidate that needs configuration claims its id without
 * registering until the environment holds it.
 */
export function builtinProviderCandidates(host: HostEnvironment): PluginCandidate[] {
  return [limrunCandidate(host)];
}

function limrunCandidate(host: HostEnvironment): PluginCandidate {
  const base = { source: 'builtin', provider: LIMRUN_ID } as const;
  let credentials: LimrunCredentials | undefined;
  try {
    credentials = readLimrunCredentials(host.env);
  } catch (error) {
    return { ...base, load: () => Promise.reject(error) };
  }
  if (!credentials) return { ...base, dormant: true, load: () => undefined };
  const limrun = credentials;
  return {
    ...base,
    load: (): AgentDevicePlugin => ({
      apiVersion: 2,
      provider: LIMRUN_ID,
      credentials: limrunCredentialDeclaration(),
      setup: async () => {
        const [runtime, dependencies] = await Promise.all([
          import('@agent-device/provider-limrun'),
          import('./sdk/limrun-runtime-dependencies.ts'),
        ]);
        return runtime.createLimrunRuntime(
          {
            ...limrun,
            // HAR captures land beside the session files, under the daemon's own state dir.
            networkHarDir: path.join(
              resolveDaemonPaths(host.env.AGENT_DEVICE_STATE_DIR, { env: host.env, cwd: host.cwd })
                .baseDir,
              'network-har',
            ),
          },
          dependencies.createLimrunRuntimeDependencies(host),
          {
            includePlatformModule: true,
          },
        );
      },
    }),
  };
}
