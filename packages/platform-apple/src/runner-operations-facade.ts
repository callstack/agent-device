export {
  applyXctestRunnerAppIconFromDerivedPath,
  detachIosRunnerSessionsForShutdown,
  findRunnerXctestrun,
  hasLiveIosRunnerSession,
  notifyIosRunnerAppRelaunched,
  prepareIosRunner,
  prewarmAppleRunnerCache,
  prewarmIosRunnerSession,
  readRunnerSessionLiveness,
  readStaleRunnerLease,
  releaseIosRunnerOnClose,
  releaseSpeculativeIosRunnerSessionFor,
  resolveExistingRunnerProductPaths,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerAppBundleId,
  resolveRunnerArchBuildSettings,
  resolveRunnerBundleBuildSettings,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  isRunnerXcuitestScriptPlatform,
  resolveRunnerScriptDevice,
  resolveRunnerSigningBuildSettings,
  requireCertifiedRunnerCacheArtifacts,
  requireRunnerBuildSettingsMatchBuildLog,
  runAppleRunnerCommand,
  stopAllIosRunnerSessions,
  stopIosRunnerSession,
  takeRunnerWarmLossNotice,
  verifyLeaseRunnerPidIdentity,
  writeRunnerCacheMetadataForArtifacts,
} from './core/runner-client.ts';
export type { RunnerWarmLossNotice } from './runner/runner-destination-watch.ts';
export { queryAppleRunnerSelector } from './core/runner-selector-query.ts';

export async function cleanupRunnerLeasesForOwner(
  owner: Parameters<(typeof import('./core/runner-client.ts'))['cleanupRunnerLeasesForOwner']>[0],
): Promise<void> {
  const { cleanupRunnerLeasesForOwner: cleanup } = await import('./core/runner-client.ts');
  const { runnerLeaseCleanupAdapter } = await import('./runner/runner-disposal.ts');
  await cleanup(owner, runnerLeaseCleanupAdapter);
}
