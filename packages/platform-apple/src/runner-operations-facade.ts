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
  resolveRunnerDerivedOverride,
  resolveRunnerSigningBuildSettings,
  requireCertifiedRunnerCacheArtifacts,
  requireRunnerBuildSettingsMatchBuildLog,
  runAppleRunnerCommand,
  stopAllIosRunnerSessions,
  stopIosRunnerSession,
  verifyLeaseRunnerPidIdentity,
  writeRunnerCacheMetadataForArtifacts,
} from './core/runner-client.ts';
export {
  isRunnerXcuitestScriptPlatform,
  resolveRunnerScriptDefaultDerivedPath,
  resolveRunnerScriptDevice,
} from './core/runner-script.ts';

export async function cleanupRunnerLeasesForOwner(
  owner: Parameters<(typeof import('./core/runner-client.ts'))['cleanupRunnerLeasesForOwner']>[0],
): Promise<void> {
  const { cleanupRunnerLeasesForOwner: cleanup } = await import('./core/runner-client.ts');
  const { runnerLeaseCleanupAdapter } = await import('@agent-device/apple-runner');
  await cleanup(owner, runnerLeaseCleanupAdapter);
}
