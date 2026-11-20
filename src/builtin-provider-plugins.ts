import type { PluginCandidate } from '@agent-device/plugins/registry';
import type { PluginConnectionCallbacks } from '@agent-device/plugins/connection';
import { LIMRUN_ID } from './builtin-provider-ids.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  LIMRUN_CONNECTION,
  limrunPlugin,
  readLimrunCredentials,
  type LimrunPluginOptions,
} from '@agent-device/provider-limrun/internal';

/**
 * The built-in providers as registry candidates, in the shape a plugin has. Their implementations
 * load only when a runtime is set up; a candidate that needs configuration claims its id without
 * registering until the environment holds it.
 */
export function builtinProviderCandidates(host: HostEnvironment): PluginCandidate[] {
  return [limrunCandidate(host)];
}

function limrunCandidate(host: HostEnvironment): PluginCandidate {
  const base = {
    source: 'builtin' as const,
    declaredClaims: [{ kind: 'provider' as const, id: LIMRUN_ID }],
  };
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
    load: () => limrunPlugin(builtinLimrunPluginOptions(host)),
  };
}

/**
 * How the composing root answers what the built-in provider asks for: the platform's own host
 * adapters build its runtime.
 */
function builtinLimrunPluginOptions(host: HostEnvironment): LimrunPluginOptions {
  return {
    // The host adapters are the root's own: the provider names what a runtime needs, and this
    // composition answers with its platform owners and this host's env/cwd.
    createDependencies: async () =>
      (await import('./sdk/limrun-runtime-dependencies.ts')).createLimrunRuntimeDependencies(host),
    // HAR captures land beside the session files, under the daemon's own state dir. The state
    // dir is resolved with the load, so an unconfigured process never probes for one.
    stateDir: resolveDaemonPaths(host.env.AGENT_DEVICE_STATE_DIR, {
      env: host.env,
      cwd: host.cwd,
    }).baseDir,
  };
}

/**
 * The built-in Limrun connection the CLI `connect` runs: the provider's own callbacks, wired to the
 * calling invocation's host the same way the daemon's registry wires an installed plugin's. The
 * read-only check is the provider's own, so both answers verify through one entry, and the SDK loads
 * only when a callback runs.
 */
export async function builtinLimrunConnection(): Promise<PluginConnectionCallbacks> {
  const { withConnectionHost } = await import('@agent-device/plugins/registry');
  const connection = withConnectionHost(LIMRUN_CONNECTION, undefined);
  return { resolve: connection.resolve, verify: connection.verify };
}
