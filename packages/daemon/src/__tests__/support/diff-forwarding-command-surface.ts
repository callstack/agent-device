import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import { forwardingCreateCommandSurface } from './command-surface-fake.ts';

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
