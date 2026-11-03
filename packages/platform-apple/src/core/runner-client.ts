import {
  bindAppleRunnerHost,
  resolveRunnerRequestSignal,
  runnerCommandResolvesSurface,
  runAppleRunnerCommand as runHostBoundAppleRunnerCommand,
  type AppleRunnerCommandOptions,
  type RunnerCommand,
} from '@agent-device/apple-runner';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appleRunnerHost } from './runner-host.ts';

/**
 * Composition root for the Apple runner operations: the only module that binds
 * the real host capabilities from `runner-host.ts`, and the module daemon,
 * platform, and CLI consumers import the host-bound operations from, so every
 * such consumer evaluates after the binding. Runner modules must not reach the
 * host while they evaluate: they load before this module binds it. Import types and
 * host-free helpers from the package façade when no host binding is needed.
 */
bindAppleRunnerHost(appleRunnerHost);

/**
 * Sends `command` to the runner. A command that resolves a screen names the lit panel for a
 * multi-panel device. The panel probe loads on first use, because this module is in the eager closure
 * of the Apple façades (ADR 0019).
 */
export async function runAppleRunnerCommand(
  device: DeviceInfo,
  command: RunnerCommand,
  options: AppleRunnerCommandOptions = {},
): Promise<Record<string, unknown>> {
  if (!runnerCommandResolvesSurface(command)) {
    return await runHostBoundAppleRunnerCommand(device, command, options);
  }
  const { nameRunnerRequestLitPanel } = await import('../foldable/runner-panel.ts');
  return await runHostBoundAppleRunnerCommand(
    device,
    await nameRunnerRequestLitPanel(device, command, resolveRunnerRequestSignal(options)),
    options,
  );
}

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
  stopAllIosRunnerSessions,
  stopIosRunnerSession,
  verifyLeaseRunnerPidIdentity,
  writeRunnerCacheMetadataForArtifacts,
} from '@agent-device/apple-runner';
