import { bindAppleRunnerHost } from '../runner/host.ts';
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
  hasLiveIosRunnerSession,
  notifyIosRunnerAppRelaunched,
  prepareIosRunner,
  prewarmAppleRunnerCache,
  prewarmIosRunnerSession,
  releaseSpeculativeIosRunnerSessionFor,
  runAppleRunnerCommand,
} from '../runner/runner-client.ts';
export { applyXctestRunnerAppIconFromDerivedPath } from '../runner/runner-icon.ts';
export {
  cleanupRunnerLeasesForOwner,
  readStaleRunnerLease,
  verifyLeaseRunnerPidIdentity,
} from '../runner/runner-lease.ts';
export { runApplePressSeries } from '../runner/runner-sequence.ts';
export {
  detachIosRunnerSessionsForShutdown,
  readRunnerSessionLiveness,
  releaseIosRunnerOnClose,
  stopAllIosRunnerSessions,
  stopIosRunnerSession,
} from '../runner/runner-session.ts';
import type { RunnerWarmLossNotice } from '../runner/runner-destination-watch.ts';

/**
 * Takes the #3321 warm-runner loss notice recorded for this device, once, if a retained runner was
 * stopped because its connection closed during retention. Loaded on call, not at import:
 * the watcher module must not join the façade closures the eager-closure budget holds flat, and
 * the read happens once per `open` at most.
 */
export async function takeRunnerWarmLossNotice(
  deviceId: string,
): Promise<RunnerWarmLossNotice | undefined> {
  const { takeRunnerWarmLossNotice: take } = await import('../runner/runner-destination-watch.ts');
  return take(deviceId);
}
export {
  hasCachedAppleRunnerArtifact,
  resolveRunnerAppBundleId,
} from '../runner/runner-xctestrun.ts';
export { findXctestrun as findRunnerXctestrun } from '../runner/runner-artifact.ts';
export { resolveExistingXctestrunProductPaths as resolveExistingRunnerProductPaths } from '../runner/runner-xctestrun-products.ts';
export {
  requireRunnerBuildSettingsMatchBuildLog,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerArchBuildSettings,
  resolveRunnerBundleBuildSettings,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveRunnerSigningBuildSettings,
} from '../runner/runner-cache-metadata.ts';
export {
  isRunnerXcuitestScriptPlatform,
  resolveRunnerScriptDevice,
} from '../runner/apple-runner-platform.ts';
export {
  requireCertifiedRunnerCacheArtifacts,
  writeRunnerCacheMetadataForArtifacts,
} from '../runner/runner-cache.ts';
