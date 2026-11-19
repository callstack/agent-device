import type { AgentDevicePlugin } from '@agent-device/plugins/contract';
import type { PluginCandidate } from '@agent-device/plugins/registry';
import { LIMRUN_ID } from './builtin-provider-ids.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { limrunPlugin, readLimrunCredentials } from '@agent-device/provider-limrun/internal';

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
  // The provider owns what counts as its credentials; the candidate only asks whether this host
  // holds them, so an unconfigured process keeps the id dormant and never loads the runtime.
  let configured: boolean;
  try {
    configured = readLimrunCredentials(host.env) !== undefined;
  } catch (error) {
    return { ...base, load: () => Promise.reject(error) };
  }
  if (!configured) return { ...base, dormant: true, load: () => undefined };
  return {
    ...base,
    load: (): AgentDevicePlugin =>
      limrunPlugin({
        // The host adapters are the root's own: the provider names what a runtime needs, and this
        // composition answers with its platform owners and this host's env/cwd.
        createDependencies: async () =>
          (await import('./sdk/limrun-runtime-dependencies.ts')).createLimrunRuntimeDependencies(
            host,
          ),
        // HAR captures land beside the session files, under the daemon's own state dir. The state
        // dir is resolved with the load, so an unconfigured process never probes for one.
        stateDir: resolveDaemonPaths(host.env.AGENT_DEVICE_STATE_DIR, {
          env: host.env,
          cwd: host.cwd,
        }).baseDir,
      }),
  };
}
