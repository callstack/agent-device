export {
  applyXctestRunnerAppIconFromDerivedPath,
  detachIosSimulatorRunnerSessionsForShutdown,
  getRunnerSessionSnapshot,
  notifyIosRunnerAppRelaunched,
  prepareIosRunner,
  prewarmAppleRunnerCache,
  prewarmIosRunnerSession,
  readStaleRunnerLease,
  resolveRunnerAppBundleId,
  runAppleRunnerCommand,
  scheduleIosRunnerIdleStop,
  stopAllIosRunnerSessions,
  stopIosRunnerSession,
  verifyLeaseRunnerPidIdentity,
} from './core/runner-client.ts';
export { queryAppleRunnerSelector } from './core/runner-selector-query.ts';

export async function cleanupRunnerLeasesForOwner(
  owner: Parameters<(typeof import('./core/runner-client.ts'))['cleanupRunnerLeasesForOwner']>[0],
): Promise<void> {
  const { cleanupRunnerLeasesForOwner: cleanup } = await import('./core/runner-client.ts');
  const { runnerLeaseCleanupAdapter } = await import('./runner/runner-disposal.ts');
  await cleanup(owner, runnerLeaseCleanupAdapter);
}
