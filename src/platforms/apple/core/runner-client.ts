import {
  createAppleRunnerClient,
  type AppleRunnerClient,
} from '@agent-device/platform-apple/runner/client';
import { appleRunnerHost } from './runner-host.ts';

/**
 * Composition root for the Apple runner client (`@agent-device/platform-apple/runner`).
 * This is the only module that constructs the client: it supplies the real
 * host capabilities from `runner-host.ts` and re-exposes the bound operations
 * under their historical names for daemon, platform, and CLI consumers. Types
 * and host-free helpers come from the package façade directly.
 *
 * Each export below carries an explicit `AppleRunnerClient[...]` annotation
 * (rather than a destructuring re-export) because the package's operation
 * types resolve through its private modules; without an annotation naming
 * the public `AppleRunnerClient` type, dts emit cannot print a portable type
 * for the inferred signature (TS2883).
 */
const client: AppleRunnerClient = createAppleRunnerClient(appleRunnerHost);

export const runAppleRunnerCommand: AppleRunnerClient['runAppleRunnerCommand'] =
  client.runAppleRunnerCommand;
export const notifyIosRunnerAppRelaunched: AppleRunnerClient['notifyIosRunnerAppRelaunched'] =
  client.notifyIosRunnerAppRelaunched;
export const prewarmAppleRunnerCache: AppleRunnerClient['prewarmAppleRunnerCache'] =
  client.prewarmAppleRunnerCache;
export const prewarmIosRunnerSession: AppleRunnerClient['prewarmIosRunnerSession'] =
  client.prewarmIosRunnerSession;
export const prepareIosRunner: AppleRunnerClient['prepareIosRunner'] = client.prepareIosRunner;
export const resolveRunnerAppBundleId: AppleRunnerClient['resolveRunnerAppBundleId'] =
  client.resolveRunnerAppBundleId;
export const hasCachedAppleRunnerArtifact: AppleRunnerClient['hasCachedAppleRunnerArtifact'] =
  client.hasCachedAppleRunnerArtifact;
export const detachIosSimulatorRunnerSessionsForShutdown: AppleRunnerClient['detachIosSimulatorRunnerSessionsForShutdown'] =
  client.detachIosSimulatorRunnerSessionsForShutdown;
export const getRunnerSessionSnapshot: AppleRunnerClient['getRunnerSessionSnapshot'] =
  client.getRunnerSessionSnapshot;
export const scheduleIosRunnerIdleStop: AppleRunnerClient['scheduleIosRunnerIdleStop'] =
  client.scheduleIosRunnerIdleStop;
export const stopIosRunnerSession: AppleRunnerClient['stopIosRunnerSession'] =
  client.stopIosRunnerSession;
export const stopAllIosRunnerSessions: AppleRunnerClient['stopAllIosRunnerSessions'] =
  client.stopAllIosRunnerSessions;
export const runApplePressSeries: AppleRunnerClient['runApplePressSeries'] =
  client.runApplePressSeries;
export const cleanupRunnerLeasesForOwner: AppleRunnerClient['cleanupRunnerLeasesForOwner'] =
  client.cleanupRunnerLeasesForOwner;
export const readStaleRunnerLease: AppleRunnerClient['readStaleRunnerLease'] =
  client.readStaleRunnerLease;
export const verifyLeaseRunnerPidIdentity: AppleRunnerClient['verifyLeaseRunnerPidIdentity'] =
  client.verifyLeaseRunnerPidIdentity;
export const runnerLeaseCleanupAdapter: AppleRunnerClient['runnerLeaseCleanupAdapter'] =
  client.runnerLeaseCleanupAdapter;
export const applyXctestRunnerAppIconFromDerivedPath: AppleRunnerClient['applyXctestRunnerAppIconFromDerivedPath'] =
  client.applyXctestRunnerAppIconFromDerivedPath;
