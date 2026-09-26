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
  resolveRunnerScriptDevice,
  resolveRunnerSigningBuildSettings,
  requireRunnerBuildSettingsMatchBuildLog,
  runAppleRunnerCommand,
  stopAllIosRunnerSessions,
  stopIosRunnerSession,
  verifyLeaseRunnerPidIdentity,
  writeRunnerCacheMetadataForArtifacts,
} from './core/runner-client.ts';
export { queryAppleRunnerSelector } from './core/runner-selector-query.ts';
export { restoreLegacyXctestDeviceSetRedirect } from './runner/runner-device-set.ts';

export async function cleanupRunnerLeasesForOwner(
  owner: Parameters<(typeof import('./core/runner-client.ts'))['cleanupRunnerLeasesForOwner']>[0],
): Promise<void> {
  const { cleanupRunnerLeasesForOwner: cleanup } = await import('./core/runner-client.ts');
  const { runnerLeaseCleanupAdapter } = await import('./runner/runner-disposal.ts');
  await cleanup(owner, runnerLeaseCleanupAdapter);
}
