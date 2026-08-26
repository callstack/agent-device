import { bindAppleRunnerHost, type AppleRunnerHost } from './host.ts';
import {
  notifyIosRunnerAppRelaunched,
  prepareIosRunner,
  prewarmAppleRunnerCache,
  prewarmIosRunnerSession,
  runAppleRunnerCommand,
} from './runner-client.ts';
import { applyXctestRunnerAppIconFromDerivedPath } from './runner-icon.ts';
import {
  cleanupRunnerLeasesForOwner,
  readStaleRunnerLease,
  verifyLeaseRunnerPidIdentity,
} from './runner-lease.ts';
import { runnerLeaseCleanupAdapter } from './runner-disposal.ts';
import { runApplePressSeries } from './runner-sequence.ts';
import {
  detachIosSimulatorRunnerSessionsForShutdown,
  getRunnerSessionSnapshot,
  scheduleIosRunnerIdleStop,
  stopAllIosRunnerSessions,
  stopIosRunnerSession,
} from './runner-session.ts';
import { hasCachedAppleRunnerArtifact, resolveRunnerAppBundleId } from './runner-xctestrun.ts';

/**
 * The host-bound operation surface of the Apple runner client. Everything on
 * this object reaches host capabilities (process execution, diagnostics,
 * locks, Apple tooling) at call time; the package façade deliberately does not
 * export these operations as free functions, so the only way to obtain them is
 * through {@link createAppleRunnerClient} with a concrete host.
 */
export type AppleRunnerClient = {
  runAppleRunnerCommand: typeof runAppleRunnerCommand;
  notifyIosRunnerAppRelaunched: typeof notifyIosRunnerAppRelaunched;
  prewarmAppleRunnerCache: typeof prewarmAppleRunnerCache;
  prewarmIosRunnerSession: typeof prewarmIosRunnerSession;
  prepareIosRunner: typeof prepareIosRunner;
  resolveRunnerAppBundleId: typeof resolveRunnerAppBundleId;
  hasCachedAppleRunnerArtifact: typeof hasCachedAppleRunnerArtifact;
  detachIosSimulatorRunnerSessionsForShutdown: typeof detachIosSimulatorRunnerSessionsForShutdown;
  getRunnerSessionSnapshot: typeof getRunnerSessionSnapshot;
  scheduleIosRunnerIdleStop: typeof scheduleIosRunnerIdleStop;
  stopIosRunnerSession: typeof stopIosRunnerSession;
  stopAllIosRunnerSessions: typeof stopAllIosRunnerSessions;
  runApplePressSeries: typeof runApplePressSeries;
  cleanupRunnerLeasesForOwner: typeof cleanupRunnerLeasesForOwner;
  readStaleRunnerLease: typeof readStaleRunnerLease;
  verifyLeaseRunnerPidIdentity: typeof verifyLeaseRunnerPidIdentity;
  runnerLeaseCleanupAdapter: typeof runnerLeaseCleanupAdapter;
  applyXctestRunnerAppIconFromDerivedPath: typeof applyXctestRunnerAppIconFromDerivedPath;
};

/**
 * Binds the host capabilities and returns the runner operation surface. The
 * runner keeps process-wide state (sessions, leases, provider scopes), so one
 * process gets one host: constructing a second client with a different host
 * reference throws.
 */
export function createAppleRunnerClient(host: AppleRunnerHost): AppleRunnerClient {
  bindAppleRunnerHost(host);
  return {
    runAppleRunnerCommand,
    notifyIosRunnerAppRelaunched,
    prewarmAppleRunnerCache,
    prewarmIosRunnerSession,
    prepareIosRunner,
    resolveRunnerAppBundleId,
    hasCachedAppleRunnerArtifact,
    detachIosSimulatorRunnerSessionsForShutdown,
    getRunnerSessionSnapshot,
    scheduleIosRunnerIdleStop,
    stopIosRunnerSession,
    stopAllIosRunnerSessions,
    runApplePressSeries,
    cleanupRunnerLeasesForOwner,
    readStaleRunnerLease,
    verifyLeaseRunnerPidIdentity,
    runnerLeaseCleanupAdapter,
    applyXctestRunnerAppIconFromDerivedPath,
  };
}
