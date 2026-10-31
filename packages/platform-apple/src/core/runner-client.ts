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
 * host while they evaluate: they load before this module binds it. Types and
 * host-free helpers come from the package façade directly.
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
  if (command.litPanel || !runnerCommandResolvesSurface(command)) {
    return await runHostBoundAppleRunnerCommand(device, command, options);
  }
  const { resolveRunnerRequestLitPanel } = await import('../foldable/runner-panel.ts');
  const litPanel = await resolveRunnerRequestLitPanel(device, {
    signal: resolveRunnerRequestSignal(options),
    requestTimeoutMs: command.timeoutMs,
  });
  return await runHostBoundAppleRunnerCommand(
    device,
    litPanel ? { ...command, litPanel } : command,
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
