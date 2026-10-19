import type {
  CreateDaemonCommandSurface,
  DaemonCommandSurface,
} from '@agent-device/contracts/daemon-command-surface';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import type { SnapshotPreferredBackend, SnapshotState } from '@agent-device/kernel/snapshot';
import { fakeCreateCommandSurface } from './command-surface-fake.ts';

export type CommandSurfaceMembers = {
  capture?: Partial<DaemonCommandSurface['capture']>;
  selectors?: Partial<DaemonCommandSurface['selectors']>;
  interactions?: Partial<DaemonCommandSurface['interactions']>;
};

/**
 * The inert command surface with the members a suite names answered by that suite. The daemon
 * suites that reach a selector read or a touch action use it to state what the command family
 * answered, so every assertion stays about what the daemon does with the answer. `members` runs
 * once per surface the daemon builds and receives that request's runtime config, which is how a
 * member reaches the same `backend` and `sessions` seams the real command family reaches.
 */
export function commandSurfaceWithMembers(
  members: (config: AgentDeviceRuntimeConfig) => CommandSurfaceMembers,
): CreateDaemonCommandSurface {
  return async (config) => {
    const inert = await fakeCreateCommandSurface(config);
    const own = members(config);
    return {
      ...inert,
      signal: config.signal,
      capture: { ...inert.capture, ...own.capture },
      selectors: { ...inert.selectors, ...own.selectors },
      interactions: { ...inert.interactions, ...own.interactions },
    };
  };
}

/**
 * One capture the way the real command family takes it: through the config's backend, then
 * written back as the session's stored snapshot through the config's session store.
 */
export async function captureAndStoreSnapshot(
  config: AgentDeviceRuntimeConfig,
  params: {
    session?: string;
    requestId?: string;
    signal?: AbortSignal;
    interactiveOnly?: boolean;
    includeRects?: boolean;
    preferredBackend?: SnapshotPreferredBackend;
    onlyStoreWhenSessionExists?: boolean;
  },
): Promise<SnapshotState> {
  const name = params.session ?? 'default';
  const captured = await config.backend.captureSnapshot?.(
    { session: name, requestId: params.requestId, signal: params.signal ?? config.signal },
    {
      interactiveOnly: params.interactiveOnly,
      includeRects: params.includeRects,
      preferredBackend: params.preferredBackend,
    },
  );
  const snapshot = captured?.snapshot;
  if (!snapshot) throw new Error('captureAndStoreSnapshot: the backend returned no snapshot');
  const current = await config.sessions?.get(name);
  if (current || !params.onlyStoreWhenSessionExists) {
    await config.sessions?.set({ ...(current ?? { name }), name, snapshot });
  }
  return snapshot;
}
