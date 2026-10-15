import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import {
  fakeCreateCommandSurface,
  forwardingCreateCommandSurface,
} from './command-surface-fake.ts';

/**
 * `forwardingCreateCommandSurface` plus a `diffSnapshot` that stores the tree it observed the way
 * the real diff command does: through the session seam the daemon owns. The comparison itself
 * (summary, lines, baseline initialization) belongs to the command family, so the result is an
 * empty comparison.
 */
export const diffForwardingCreateCommandSurface: CreateDaemonCommandSurface = async (config) => {
  const surface = await forwardingCreateCommandSurface(config);
  return {
    ...surface,
    capture: {
      ...surface.capture,
      diffSnapshot: async (options) => {
        await surface.capture.snapshot(options);
        return {
          mode: 'snapshot',
          baselineInitialized: false,
          summary: { additions: 0, removals: 0, unchanged: 0 },
          lines: [],
        };
      },
    },
  };
};

/**
 * A command surface whose snapshot capture stores the backend's snapshot state as captured, so a
 * suite can pin what the daemon's session seam does with the stored tree (scope lineage, ref
 * reindexing, replacement rules) without the command family's own response shaping.
 */
export const storingCreateCommandSurface: CreateDaemonCommandSurface = async (config) => {
  const surface = await fakeCreateCommandSurface(config);
  return {
    ...surface,
    signal: config.signal,
    capture: {
      ...surface.capture,
      snapshot: async (options) => {
        const name = options.session ?? 'default';
        const session = await config.sessions?.get(name);
        const captured = await config.backend.captureSnapshot?.(
          { session: name, requestId: options.requestId, signal: options.signal ?? config.signal },
          { interactiveOnly: options.interactiveOnly, depth: options.depth, scope: options.scope },
        );
        const snapshot = captured?.snapshot ?? {
          nodes: captured?.nodes ?? [],
          createdAt: Date.now(),
          backend: 'android' as const,
        };
        await config.sessions?.set({
          ...(session ?? { name }),
          name: session?.name ?? name,
          snapshot,
        });
        return { nodes: snapshot.nodes };
      },
    },
  };
};
