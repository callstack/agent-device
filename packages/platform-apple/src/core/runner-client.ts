import { bindAppleRunnerHost } from '@agent-device/apple-runner';
import { appleRunnerHost } from './runner-host.ts';

/**
 * Composition root for the Apple runner operations: the only module that binds
 * the real host capabilities from `runner-host.ts`, and the module daemon,
 * platform, and CLI consumers import the host-bound operations from, so every
 * such consumer evaluates after the binding. Runner modules must not reach the
 * host while they evaluate: they load before this module binds it. Types and
 * host-free helpers come from the package façade directly.
 */
bindAppleRunnerHost(appleRunnerHost);

export {
  applyXctestRunnerAppIconFromDerivedPath,
  cleanupRunnerLeasesForOwner,
  detachIosRunnerSessionsForShutdown,
  findRunnerXctestrun,
  hasCachedAppleRunnerArtifact,
  hasLiveIosRunnerSession,
  notifyIosRunnerAppRelaunched,
  prepareIosRunner,
  prewarmAppleRunnerCache,
  prewarmIosRunnerSession,
  readRunnerSessionLiveness,
  readStaleRunnerLease,
  releaseIosRunnerOnClose,
  releaseSpeculativeIosRunnerSessionFor,
  requireCertifiedRunnerCacheArtifacts,
  requireRunnerBuildSettingsMatchBuildLog,
  resolveExistingRunnerProductPaths,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerAppBundleId,
  resolveRunnerArchBuildSettings,
  resolveRunnerBundleBuildSettings,
  resolveRunnerDerivedOverride,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveRunnerSigningBuildSettings,
  runApplePressSeries,
  runAppleRunnerCommand,
  stopAllIosRunnerSessions,
  stopIosRunnerSession,
  verifyLeaseRunnerPidIdentity,
  writeRunnerCacheMetadataForArtifacts,
} from '@agent-device/apple-runner';
