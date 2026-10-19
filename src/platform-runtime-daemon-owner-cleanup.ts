import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonOwnerCleanup } from '@agent-device/daemon-contracts/daemon-owner-cleanup';

/**
 * Root composition for owner-scoped host cleanup. The CLI names only the neutral service; Apple
 * runner lease discovery and process disposal stay behind the platform composition boundary.
 * `host` is the calling CLI's host; lease discovery reads runner configuration from it, entered
 * as the runtime state the daemon route binds (#3794).
 */
export function createDaemonOwnerCleanup(host: HostEnvironment): DaemonOwnerCleanup {
  return Object.freeze({
    cleanup: async (owner) => {
      const { setAppleRunnerHostEnvironment } =
        await import('@agent-device/platform-apple/runner-owner');
      setAppleRunnerHostEnvironment(host);
      const { cleanupRunnerLeasesForOwner } =
        await import('@agent-device/platform-apple/runner/operations');
      await cleanupRunnerLeasesForOwner(owner);
    },
  });
}
