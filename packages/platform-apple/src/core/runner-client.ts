import {
  bindAppleRunnerHost,
  runAppleRunnerCommand as runHostBoundAppleRunnerCommand,
  type AppleRunnerCommandOptions,
  type RunnerCommand,
} from '@agent-device/apple-runner';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppleLitPanel } from '@agent-device/contracts/interactor-types';
import { appleRunnerHost } from './runner-host.ts';

/**
 * Composition root for the Apple runner operations: the only module that binds the real host
 * capabilities from `runner-host.ts`, and the module daemon, platform, and CLI consumers import the
 * host-bound operations from, so every such consumer evaluates after the binding. Runner modules
 * must not reach the host while they evaluate: they load before this module binds it. Types and
 * host-free helpers come from the package façade directly.
 *
 * Because every Apple runner request leaves the platform through here, this is also where a request
 * that resolves a screen gains the one fact a runner cannot read for itself: which panel is lit.
 */
bindAppleRunnerHost(appleRunnerHost);

/**
 * Runner commands whose execution resolves a screen — a window to book a gesture against, a viewport
 * to place a capture or a snapshot in, or the display to capture. Each of them used the application's
 * first window, which on a foldable home screen is SpringBoard's status-bar window on a panel that
 * may be dark, so each carries the panel the host read as lit for the request.
 *
 * A command outside this set resolves no surface and carries no panel: readiness, lifecycle,
 * clipboard and element- or selector-targeted traffic stays byte-for-byte the request it was.
 */
const RUNNER_SURFACE_RESOLVING_COMMANDS: ReadonlySet<RunnerCommand['command']> = new Set([
  'tap',
  'longPress',
  'drag',
  'type',
  'swipe',
  'scroll',
  'gesture',
  'sequence',
  'backInApp',
  'backSystem',
  'appSwitcher',
  'gestureViewport',
  'snapshot',
  'screenshot',
  // Both sample the screen from the runner: `recordStart` sizes and pumps its frames, and
  // `keyboardDismiss` fingerprints screenshots to settle. Without the panel they would read the
  // dark panel and report success — an all-black clip, or a keyboard that "settled" on a screen
  // that never changed. `readText` resolves the surface window to place the point it was handed.
  'recordStart',
  'keyboardDismiss',
  'readText',
]);

/**
 * The request as the wire carries it: a surface-resolving command for a multi-panel device names the
 * lit panel, and anything else is the command it was. A command that already names a panel is left
 * alone, so a caller that resolved one for its whole sequence is not overruled mid-flight.
 */
function withRunnerRequestLitPanel(
  command: RunnerCommand,
  litPanel: AppleLitPanel | undefined,
): RunnerCommand {
  if (!litPanel || command.litPanel || !RUNNER_SURFACE_RESOLVING_COMMANDS.has(command.command)) {
    return command;
  }
  return { ...command, litPanel };
}

/**
 * Sends `command` to the runner, naming the lit panel when the device presents more than one panel and
 * the command resolves a screen. A single-panel device, an unreadable panel table, and a multi-panel
 * device whose table decides nothing all send no panel, and the runner keeps its historic surface
 * route.
 *
 * The panel owner is loaded on first use, not at module load: this module sits in the eager closure
 * of the Apple façades, and the panel probe is host tooling only a multi-panel request needs (ADR
 * 0019).
 */
export async function runAppleRunnerCommand(
  device: DeviceInfo,
  command: RunnerCommand,
  options: AppleRunnerCommandOptions = {},
): Promise<Record<string, unknown>> {
  if (!RUNNER_SURFACE_RESOLVING_COMMANDS.has(command.command)) {
    return await runHostBoundAppleRunnerCommand(device, command, options);
  }
  const { resolveRunnerRequestLitPanel } = await import('../foldable/runner-panel.ts');
  const litPanel = await resolveRunnerRequestLitPanel(device, { signal: options.signal });
  return await runHostBoundAppleRunnerCommand(
    device,
    withRunnerRequestLitPanel(command, litPanel),
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

export type { AppleRunnerCommandOptions, RunnerCommand };
