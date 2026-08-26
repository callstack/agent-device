import { createAppleRunnerClient } from '@agent-device/platform-apple/runner/client';
import { appleRunnerHost } from './runner-host.ts';

/**
 * Composition root for the Apple runner client (`@agent-device/platform-apple/runner`).
 * This is the only module that constructs the client: it supplies the real
 * host capabilities from `runner-host.ts` and re-exposes the bound operations
 * under their historical names for daemon, platform, and CLI consumers. Types
 * and host-free helpers come from the package façade directly.
 */
const client = createAppleRunnerClient(appleRunnerHost);

export const {
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
} = client;
