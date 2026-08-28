import type { DaemonOwnerCleanup } from '@agent-device/contracts/daemon-owner-cleanup';

/**
 * Root composition for owner-scoped host cleanup. The CLI names only the neutral service; Apple
 * runner lease discovery and process disposal stay behind the platform composition boundary.
 */
export function createDaemonOwnerCleanup(): DaemonOwnerCleanup {
  return Object.freeze({
    cleanup: async (owner) => {
      const { cleanupRunnerLeasesForOwner } =
        await import('@agent-device/platform-apple/runner/operations');
      await cleanupRunnerLeasesForOwner(owner);
    },
  });
}
