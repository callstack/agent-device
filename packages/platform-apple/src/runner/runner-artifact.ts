import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  runCmdStreaming,
  withKeyedLock,
  withProcessLock,
  emitDiagnostic,
  emitRequestProgress,
  findProjectRoot,
  isCommandTimeoutError,
} from './host.ts';
import type { ExecBackgroundResult } from '@agent-device/host-kit/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { classifyRunnerStartupFailure } from './runner-error-classification.ts';
import { logChunk } from './runner-io.ts';
import {
  runnerSimulatorSetFailureDetails,
  simulatorSetDestinationNotFoundMessage,
  xcodebuildDestinationArgs,
} from './runner-device-set.ts';
import {
  acquireRunnerXctestrunCacheLock,
  assertSafeDerivedCleanup,
  cleanRunnerDerivedArtifacts,
  cleanRunnerDerivedBeforeEvaluation,
  emitRunnerXctestrunDecision,
  emitRunnerXctestrunRebuildDecision,
  evaluateExistingXctestrun,
  requireRunnerPhaseRemainingMs,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerArchBuildSettings,
  resolveRunnerBuildLocationSettings,
  resolveRunnerBundleBuildSettings,
  resolveRunnerDerivedPath,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveRunnerSigningBuildSettings,
  requireCertifiedRunnerCacheArtifacts,
  writeRunnerCacheMetadataForArtifacts,
  type ExistingXctestrunState,
  type RunnerPhaseBudget,
  type RunnerXctestrunCacheKind,
  type RunnerXctestrunCacheMetadata,
} from './runner-cache.ts';
import {
  repairMacOsRunnerProductsIfNeeded,
  isExpectedRunnerRepairFailure,
} from './runner-macos-products.ts';
import { resolveExistingXctestrunProductPaths } from './runner-xctestrun-products.ts';
import { applyXctestRunnerAppIcon } from './runner-icon.ts';
import {
  resolveRunnerBuildDestination,
  resolveRunnerXctestrunHints,
} from './apple-runner-platform.ts';
import { resolveRunnerCacheKey } from './runner-cache-metadata.ts';
import { resolveAppleRunnerProjectPath } from './runner-source.ts';
export { prepareXctestrunWithEnv } from './runner-artifact-env.ts';

const runnerXctestrunBuildLocks = new Map<string, Promise<unknown>>();

/**
 * Why a runner start can no longer prepare its device. `device_teardown` is an explicit teardown
 * (a non-retained `close`, a daemon stop); `last_waiter_canceled` is the final interested waiter
 * cancelling the start.
 */
export type RunnerStartRetirementReason = 'device_teardown' | 'last_waiter_canceled';

/**
 * Whether one runner start may still prepare its device: spawn a preparation subprocess
 * (`xcodebuild build-for-testing`) or publish the runner it built.
 *
 * The token belongs to the START, not to the device, and it closes on the first of:
 *
 * - **An explicit teardown** ({@link fenceRunnerStartAdmissionsForTeardown}), which fences every
 *   start in flight on the device BEFORE the teardown stops the current prep children or waits for
 *   the session lock. A start parked mid-build answers the kill by failing its own spawn check
 *   instead of rebuilding, which is what keeps close from waiting on a replacement build (#3220).
 * - **The last interested waiter cancelling** ({@link cancelRunnerStartWaiter}). Waiters are
 *   counted, so one waiter leaving while another still expects the session preserves the work;
 *   only the final cancellation closes admission.
 *
 * Independent opens are separate starts: they queue on the session lock as they always have and
 * carry their own token, which no other start's teardown touches. A start that merely QUEUED
 * behind a teardown is readmitted once that teardown settles
 * ({@link readmitRunnerStartAdmission}), so the fence refuses the retiring start's own retries and
 * mid-close work, not every later open. The preparation-spawn seam and the session-publish point
 * read the verdict immediately before they act.
 */
export type RunnerStartAdmission = Readonly<{
  deviceId: string;
  /** Whether preparation and publication are still admitted for a start holding this token. */
  admitted: boolean;
  /** Why admission closed, or `undefined` while it is open. */
  retired: RunnerStartRetirementReason | undefined;
}>;

type StartAdmission = RunnerStartAdmission & {
  readonly interestedWaiters: Set<AbortSignal>;
  /** True for a token an `ensureRunnerSession` call minted for itself, never a supplied one. */
  readonly mintedByStart: boolean;
  /** A caller left this start on its own deadline while it runs: its retry is still owed (#2894). */
  retryPending: boolean;
  close(reason: RunnerStartRetirementReason): boolean;
  readmit(): void;
};

type DeviceStartState = {
  /** Explicit teardowns in flight on this device; while positive, no preparation is admitted. */
  pendingTeardowns: number;
  /** The tokens of the starts in flight on this device — the fence's sweep set, nothing more. */
  inFlight: Set<StartAdmission>;
};

const deviceStartStates = new Map<string, DeviceStartState>();

/**
 * Opens the admission one start answers to, taken when a caller asks for a runner. Registration is
 * synchronous and precedes any await, so a teardown beginning in the same turn as the start finds
 * the token and closes it even while the start queues behind the work another start holds the
 * session lock for (#3220).
 */
export function openRunnerStartAdmission(deviceId: string): RunnerStartAdmission {
  return registerStartAdmission(createStartAdmission(deviceId, true));
}

/**
 * Opens the one admission a prepare attempt loop owns and supplies to every start that loop makes
 * (#3220). A fence landing mid-loop is a verdict on the whole loop — the health retry that
 * re-entered the start is the replacement build the incident measured — so a loop token is never
 * reopened once the fence lifts, and the loop's own settle is what releases it.
 */
export function openRunnerStartLoopAdmission(deviceId: string): RunnerStartAdmission {
  return registerStartAdmission(createStartAdmission(deviceId, false));
}

/** The start settled: its token leaves the device's in-flight set. Verdicts live on the token. */
export function finishRunnerStartAdmission(admission: RunnerStartAdmission): void {
  (admission as StartAdmission).retryPending = false;
  const state = deviceStartStates.get(admission.deviceId);
  if (!state) return;
  state.inFlight.delete(admission as StartAdmission);
  forgetDeviceStartState(admission.deviceId, state);
}

/**
 * An explicit teardown fences the device: every start in flight closes BEFORE the teardown stops
 * the current prep children or takes the session lock, and while the fence stands no start
 * prepares the device — including preparation carrying no start's token, a cache prewarm's build.
 * The returned settle lifts this teardown's fence and runs as the teardown's last step;
 * overlapping teardowns count each other, so a fence never lifts while another still runs (#3220).
 */
export function fenceRunnerStartAdmissionsForTeardown(deviceId: string): () => void {
  const state = stateForDevice(deviceId);
  state.pendingTeardowns += 1;
  for (const admission of state.inFlight) {
    admission.close('device_teardown');
  }
  let settled = false;
  return () => {
    // Idempotent: a teardown may call its settle inside the lock it took and again in a
    // `finally`, and only the first call may lift the fence it raised.
    if (settled) return;
    settled = true;
    state.pendingTeardowns -= 1;
    forgetDeviceStartState(deviceId, state);
  };
}

/**
 * Daemon-wide teardown: no start may prepare any device until the settle runs. Devices carrying a
 * runner session are fenced with the rest, so a newcomer open on a session's device cannot slip a
 * build past the sweep that is about to stop it.
 */
export function retireAllRunnerStartAdmissions(additionalDeviceIds?: Iterable<string>): () => void {
  const deviceIds = new Set<string>([...deviceStartStates.keys(), ...(additionalDeviceIds ?? [])]);
  const settles = [...deviceIds].map((deviceId) => fenceRunnerStartAdmissionsForTeardown(deviceId));
  return () => {
    for (const settle of settles.splice(0)) settle();
  };
}

/**
 * Whether an explicit teardown is in flight on this device. Read where a start decides what a
 * closed token means: a queued independent open whose close has since settled is a fresh start,
 * not that teardown's retry.
 */
export function runnerStartTeardownPending(deviceId: string): boolean {
  return (deviceStartStates.get(deviceId)?.pendingTeardowns ?? 0) > 0;
}

/**
 * Re-admits a start that only ever queued behind a settled teardown: its token closed while the
 * teardown ran, no teardown is pending now, and every gate refused it work in the meantime, so it
 * runs on rather than failing for a close it never took part in (#3220 review).
 */
export function readmitRunnerStartAdmission(admission: RunnerStartAdmission): boolean {
  const start = admission as StartAdmission;
  // A loop-supplied token is a verdict on the whole loop, and the loop's own retry is exactly the
  // replacement build the fence exists for: only a start that minted its own token reruns.
  if (!start.mintedByStart || start.admitted || start.retired !== 'device_teardown') return false;
  if (runnerStartTeardownPending(start.deviceId)) return false;
  start.readmit();
  return true;
}
/**
 * The gate the preparation-spawn seam, the publish point, and the lock-entry check share. Two
 * questions, one answer: the start that owns the work must still be admitted, and the device must
 * not sit under an explicit teardown in progress. The second is what reaches preparation carrying
 * no start's token — a cache prewarm's build enqueued while close runs — because the device's
 * fence alone answers it.
 */
export function runnerStartAdmitsPreparation(
  deviceId: string,
  startAdmission?: RunnerStartAdmission,
): boolean {
  if (startAdmission && !startAdmission.admitted) return false;
  return !runnerStartTeardownPending(deviceId);
}

/**
 * The refusal a start publishes when its admission closed under it: a canceled-request error,
 * because a teardown and a last-waiter cancellation both cancel the work, carrying the typed
 * retirement reason so no caller reads a message to learn which.
 */
export function runnerStartRetiredError(reason: RunnerStartRetirementReason): AppError {
  return createRequestCanceledError({
    runnerStartRetired: true,
    runnerStartRetirementReason: reason,
  });
}

/** Throws {@link runnerStartRetiredError} once a start may no longer prepare. */
export function assertRunnerStartAdmitsPreparation(
  deviceId: string,
  startAdmission?: RunnerStartAdmission,
): void {
  if (runnerStartAdmitsPreparation(deviceId, startAdmission)) return;
  throw runnerStartRetiredError(startAdmission?.retired ?? 'device_teardown');
}

/**
 * Records a caller's interest in the outcome of this start's work, keyed by the signal through
 * which that caller can cancel. Keyed on the signal because an interested waiter is exactly a
 * caller that can still say it is not interested: a fire-and-forget prewarm carries no signal,
 * registers nothing, and must not be what keeps a live waiter's cancellation from fencing the work
 * it just abandoned (#3220).
 */
export function addRunnerStartWaiter(
  admission: RunnerStartAdmission,
  signal: AbortSignal,
): 'interested' | 'already-spent' {
  if (signal.aborted) return 'already-spent';
  (admission as StartAdmission).interestedWaiters.add(signal);
  return 'interested';
}

/**
 * A cancellation landed for this caller: reports whether it now owns stopping this start's prep
 * children — true only when admission still stands and no OTHER waiter still expects this start's
 * outcome. Owning the stop means closing admission in the same motion, or the cancelled caller's
 * build would respawn the moment the start retries (#3220).
 *
 * A cancellation that finds another waiter interested closes and stops nothing: that build belongs
 * to work somebody is still waiting for, and reaching it would be one request killing another's
 * work out from under it. A cancellation arriving after a teardown fenced the start stops nothing
 * new — the teardown owns that stop. A caller canceled before its interest ever registered is
 * covered too: if nobody else cares about this start, that caller is the only one its work can
 * still be orphaned on.
 */
export function cancelRunnerStartWaiter(
  admission: RunnerStartAdmission,
  signal: AbortSignal,
): boolean {
  const start = admission as StartAdmission;
  start.interestedWaiters.delete(signal);
  if (!start.admitted || start.interestedWaiters.size > 0) return false;
  return start.close('last_waiter_canceled');
}

/**
 * Drops one waiter's interest that was not a cancellation — its start settled, or the caller's own
 * deadline ended the wait while leaving the start running for the retry (#2894). Spent interest
 * stops counting toward the last-waiter rule; nothing closes and nothing stops, which is what keeps
 * a bounded poll from tearing down the build its own retry needs.
 */
export function releaseRunnerStartWaiter(
  admission: RunnerStartAdmission,
  signal: AbortSignal,
): void {
  (admission as StartAdmission).interestedWaiters.delete(signal);
}

function stateForDevice(deviceId: string): DeviceStartState {
  const existing = deviceStartStates.get(deviceId);
  if (existing) return existing;
  const state: DeviceStartState = { pendingTeardowns: 0, inFlight: new Set() };
  deviceStartStates.set(deviceId, state);
  return state;
}

/** Nothing fences the device and no start is in flight on it once the last of both is gone. */
function forgetDeviceStartState(deviceId: string, state: DeviceStartState): void {
  if (state.pendingTeardowns <= 0 && state.inFlight.size === 0) {
    deviceStartStates.delete(deviceId);
  }
}

function registerStartAdmission(admission: StartAdmission): StartAdmission {
  stateForDevice(admission.deviceId).inFlight.add(admission);
  return admission;
}

function createStartAdmission(deviceId: string, mintedByStart: boolean): StartAdmission {
  const interestedWaiters = new Set<AbortSignal>();
  let retired: RunnerStartRetirementReason | undefined;
  return {
    deviceId,
    interestedWaiters,
    mintedByStart,
    retryPending: false,
    get admitted() {
      return retired === undefined;
    },
    get retired() {
      return retired;
    },
    close(reason) {
      if (retired) return false;
      retired = reason;
      emitDiagnostic({
        level: 'debug',
        phase: 'ios_runner_start_admission_retired',
        data: { deviceId, reason },
      });
      return true;
    },
    readmit() {
      retired = undefined;
      emitDiagnostic({
        level: 'debug',
        phase: 'ios_runner_start_admission_readmitted',
        data: { deviceId },
      });
    },
  };
}

type RunnerPrepProcess = Readonly<{
  deviceId: string;
  /** The start whose admission admitted this child; a closed token owns stopping exactly these. */
  startAdmission: RunnerStartAdmission | undefined;
  child: ExecBackgroundResult['child'];
}>;

const runnerPrepProcessLedger = new Set<RunnerPrepProcess>();

/**
 * Records a prep subprocess (`xcodebuild build-for-testing`) against the device it builds for and
 * the start admitted to build it, so a cancellation can stop the right children (#3177). The build
 * child keeps its owning start's signal as its first cancel path; this ledger is the second one,
 * for the waiters whose cancellation the spawn never saw. Which cancellations may stop what is
 * registered here is the start admission's verdict (#3220), not a property of the child: a
 * last-waiter cancellation stops the children its own start spawned, and an explicit teardown
 * stops the device's — never a build another live start owns.
 */
export function registerRunnerPrepProcess(
  deviceId: string,
  child: ExecBackgroundResult['child'],
  startAdmission?: RunnerStartAdmission,
): void {
  const entry: RunnerPrepProcess = { deviceId, startAdmission, child };
  runnerPrepProcessLedger.add(entry);
  child.on('close', () => {
    runnerPrepProcessLedger.delete(entry);
  });
}

/** The prep subprocesses still running, for one device or for every device when none is named. */
export function runnerPrepProcessChildren(
  deviceId?: string,
): readonly ExecBackgroundResult['child'][] {
  return prepProcessEntries(deviceId).map((entry) => entry.child);
}

/**
 * The prep subprocesses a start's cancellation owns stopping: the device's builds that no live
 * caller can cancel any more (#3177). Ownership is the start admission recorded on the ledger
 * entry, and an owner is live while an interested waiter remains on that token — so a canceled
 * waiter reaches its own build (its cancel emptied the token) and the build of a start nobody is
 * waiting for any more, and never reaches a build another live caller is still waiting on. This
 * is #3193's protection carried by a structural fact rather than a lookup of whether some
 * request id still resolves to a live signal (#3220). A build no start owns — a cache prewarm's
 * direct artifact build — is nobody's to cancel, so a canceler stops it too.
 */
export function runnerPrepProcessChildrenWithoutLiveOwner(
  deviceId?: string,
): readonly ExecBackgroundResult['child'][] {
  return prepProcessEntries(deviceId)
    .filter(
      (entry) => entry.startAdmission === undefined || !hasRunnerStartOwner(entry.startAdmission),
    )
    .map((entry) => entry.child);
}

function hasRunnerStartOwner(admission: RunnerStartAdmission): boolean {
  const start = admission as StartAdmission;
  return start.interestedWaiters.size > 0 || start.retryPending;
}

/**
 * A caller left this start on its own deadline rather than cancelling it, so the start keeps
 * running for the retry that will join it (#2894). Marking the token keeps its build owned: a
 * different caller's cancellation must not reach work a retry is still owed, exactly the build
 * #3193's owner sniff refused to touch. Cleared when the start settles.
 */
export function markRunnerStartRetryPending(admission: RunnerStartAdmission): void {
  (admission as StartAdmission).retryPending = true;
}

function prepProcessEntries(deviceId?: string): readonly RunnerPrepProcess[] {
  return [...runnerPrepProcessLedger].filter(
    (entry) => deviceId === undefined || entry.deviceId === deviceId,
  );
}

export function forgetRunnerPrepProcess(child: ExecBackgroundResult['child']): void {
  for (const entry of runnerPrepProcessLedger) {
    if (entry.child === child) runnerPrepProcessLedger.delete(entry);
  }
}

export type RunnerXctestrunArtifactState = 'valid' | 'rebuilt';

export type RunnerXctestrunArtifact = {
  xctestrunPath: string;
  derived: string;
  artifact: RunnerXctestrunArtifactState;
  buildMs: number;
  xctestrunPathSource: 'manifest' | 'build' | 'external';
  reason?: string;
} & (
  | { cache: Exclude<RunnerXctestrunCacheKind, 'external'>; cacheKey: string }
  | { cache: 'external'; cacheKey?: string }
);

export type ExternalXctestRunnerOptions = {
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
};

/** What the build phase reads: its budget, and where it logs. */
type RunnerXctestrunBuildOptions = {
  verbose?: boolean;
  logPath?: string;
  traceLogPath?: string;
  /**
   * The start whose admission admits this build. A build phase a start does not own — a cache
   * prewarm — passes none and is admitted by the device's current admission alone (#3220).
   */
  startAdmission?: RunnerStartAdmission;
  /**
   * The build phase's one budget, opened by whoever owns the build: the cache decision's
   * blocking toolchain probes and `xcodebuild` spend the same clock, and the owning
   * request cancels both (#2422).
   */
  budget?: RunnerPhaseBudget;
};

export async function ensureXctestrunArtifact(
  device: DeviceInfo,
  options: RunnerXctestrunBuildOptions & {
    forceRunnerXctestrunRebuild?: boolean;
  } & ExternalXctestRunnerOptions,
): Promise<RunnerXctestrunArtifact> {
  const external = resolveExternalXctestrunArtifact(options);
  if (external) return external;

  const projectRoot = findProjectRoot();
  const expectedCacheMetadata = resolveExpectedRunnerCacheMetadata(
    device,
    projectRoot,
    options.budget,
  );
  const derived = resolveRunnerDerivedPath(device, expectedCacheMetadata);
  return await withKeyedLock(runnerXctestrunBuildLocks, derived, async () => {
    return await withProcessLock({
      acquire: () => acquireRunnerXctestrunCacheLock(derived),
      task: () =>
        ensureXctestrunUnderCacheLock({
          device,
          options,
          projectRoot,
          expectedCacheMetadata,
          derived,
          forceRebuild: options.forceRunnerXctestrunRebuild === true,
        }),
    });
  });
}

function resolveExternalXctestrunArtifact(
  options: ExternalXctestRunnerOptions,
): RunnerXctestrunArtifact | null {
  const configuredXctestrunPath = options.iosXctestrunFile?.trim();
  if (!configuredXctestrunPath) {
    return null;
  }

  const xctestrunPath = path.resolve(configuredXctestrunPath);
  if (!fs.existsSync(xctestrunPath)) {
    throw new AppError('COMMAND_FAILED', 'Configured iOS XCTest runner .xctestrun file not found', {
      configKey: 'iosXctestrunFile',
      xctestrunPath,
    });
  }

  const configuredDerivedPath = options.iosXctestDerivedDataPath?.trim();
  const derived = configuredDerivedPath
    ? path.resolve(configuredDerivedPath)
    : resolveExternalXctestDerivedDataPath(xctestrunPath);

  emitRunnerXctestrunDecision('reuse', 'external_xctestrun', {
    derived,
    xctestrunPath,
  });

  return {
    xctestrunPath,
    derived,
    cache: 'external',
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'external',
  };
}

function resolveExternalXctestDerivedDataPath(xctestrunPath: string): string {
  const hash = crypto.createHash('sha1');
  hash.update(xctestrunPath);
  const suffix = hash.digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'agent-device-ios-xctest-derived', suffix);
}

async function ensureXctestrunUnderCacheLock(params: {
  device: DeviceInfo;
  options: RunnerXctestrunBuildOptions;
  projectRoot: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  derived: string;
  forceRebuild: boolean;
}): Promise<RunnerXctestrunArtifact> {
  const { device, options, projectRoot, expectedCacheMetadata, derived } = params;
  cleanRunnerDerivedBeforeEvaluation(derived, params.forceRebuild);
  const existing = await evaluateExistingXctestrun({
    derived,
    expectedCacheMetadata,
  });
  const cache = existing.reason === 'reuse_ready' ? 'exact' : 'miss';
  const reusable = await resolveReusableXctestrunArtifact({
    device,
    derived,
    expectedCacheMetadata,
    existing,
    cache,
  });
  if (reusable) return reusable;
  if (existing.reason !== 'reuse_ready') {
    emitRunnerXctestrunRebuildDecision(existing, derived);
  }
  // Nothing survived evaluation — a certified state that failed repair, or one the manifest
  // refuses — so the tree is discarded before the rebuild. A missing manifest is not ours to
  // delete: that directory is either a first build or one the caller laid out itself.
  if (existing.reason !== 'cache_metadata_missing') {
    assertSafeDerivedCleanup(derived);
    cleanRunnerDerivedArtifacts(derived);
  }
  return await buildXctestrunArtifact({
    device,
    options,
    projectRoot,
    expectedCacheMetadata,
    derived,
    cache,
    reason: existing.reason,
  });
}

async function resolveReusableXctestrunArtifact(params: {
  device: DeviceInfo;
  derived: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  existing: ExistingXctestrunState;
  cache: Exclude<RunnerXctestrunArtifact['cache'], 'external'>;
}): Promise<RunnerXctestrunArtifact | null> {
  const { device, derived, expectedCacheMetadata, existing, cache } = params;
  if (existing.reason !== 'reuse_ready') return null;
  const reusableXctestrun = await tryReuseExistingXctestrun(
    device,
    derived,
    expectedCacheMetadata,
    existing,
  );
  if (!reusableXctestrun) return null;
  return {
    xctestrunPath: reusableXctestrun,
    derived,
    cache,
    cacheKey: resolveRunnerCacheKey(expectedCacheMetadata),
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'manifest',
  };
}

async function buildXctestrunArtifact(params: {
  device: DeviceInfo;
  options: RunnerXctestrunBuildOptions;
  projectRoot: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  derived: string;
  cache: Exclude<RunnerXctestrunArtifact['cache'], 'external'>;
  reason: ExistingXctestrunState['reason'];
}): Promise<RunnerXctestrunArtifact> {
  const { device, options, projectRoot, expectedCacheMetadata, derived, cache, reason } = params;
  const projectPath = resolveAppleRunnerProjectPath(projectRoot);

  if (!fs.existsSync(projectPath)) {
    throw new AppError('COMMAND_FAILED', 'iOS runner project not found', { projectPath });
  }

  const buildTimeoutMs = requireRunnerPhaseRemainingMs(options.budget, 'runner_xctestrun_build');
  const buildStartedAt = Date.now();
  emitRequestProgress({
    type: 'command',
    status: 'progress',
    message: 'Building Apple runner...',
  });
  await buildRunnerXctestrun(device, projectPath, derived, options, buildTimeoutMs);
  const buildMs = Math.max(0, Date.now() - buildStartedAt);

  const built = findXctestrun(derived, device);
  if (!built) {
    throw new AppError('COMMAND_FAILED', 'Failed to locate .xctestrun after build');
  }
  const builtProductPaths = await resolveExistingXctestrunProductPaths(built);
  if (!builtProductPaths) {
    throw new AppError('COMMAND_FAILED', 'Runner build is missing expected products', {
      xctestrunPath: built,
    });
  }
  await repairMacOsRunnerProductsIfNeeded(device, builtProductPaths, built);
  // Release/dev script builds patch the synthesized XCTest runner app in scripts/.
  // This covers direct local xcodebuilds triggered by ensureXctestrunArtifact on cache miss.
  // The manifest is written last so it certifies the bytes that actually run.
  await applyXctestRunnerAppIcon(builtProductPaths);
  requireCertifiedRunnerCacheArtifacts(
    await writeRunnerCacheMetadataForArtifacts(
      derived,
      expectedCacheMetadata,
      built,
      builtProductPaths,
    ),
    derived,
  );
  emitRunnerXctestrunDecision('build', 'built_new', {
    derived,
    xctestrunPath: built,
  });
  return {
    xctestrunPath: built,
    derived,
    cache,
    cacheKey: resolveRunnerCacheKey(expectedCacheMetadata),
    artifact: 'rebuilt',
    buildMs,
    xctestrunPathSource: 'build',
    reason,
  };
}

async function tryReuseExistingXctestrun(
  device: DeviceInfo,
  derived: string,
  expectedCacheMetadata: RunnerXctestrunCacheMetadata,
  existing: Extract<ExistingXctestrunState, { reason: 'reuse_ready' }>,
): Promise<string | null> {
  try {
    await repairMacOsRunnerProductsIfNeeded(device, existing.productPaths, existing.xctestrunPath);
    requireCertifiedRunnerCacheArtifacts(
      await writeRunnerCacheMetadataForArtifacts(
        derived,
        expectedCacheMetadata,
        existing.xctestrunPath,
        existing.productPaths,
      ),
      derived,
    );
    emitRunnerXctestrunDecision('reuse', 'reuse_ready', {
      derived,
      xctestrunPath: existing.xctestrunPath,
    });
    return existing.xctestrunPath;
  } catch (error) {
    if (!isExpectedRunnerRepairFailure(error)) {
      throw error;
    }
    emitRunnerXctestrunDecision('rebuild', 'repair_failed', {
      derived,
      xctestrunPath: existing.xctestrunPath,
    });
    return null;
  }
}

// Cache probe for preflight surfaces (doctor): runs the same no-build reuse
// evaluation as the ensure path (cache metadata + content-manifest validation),
// so a partial, restored, or tampered cache never reports as ready. Resolving
// the expected metadata stats the runner sources and reads tool versions
// (~100ms, cached per process) and the manifest digests the products (tens of
// ms) but never builds.
export async function hasCachedAppleRunnerArtifact(device: DeviceInfo): Promise<boolean> {
  try {
    const projectRoot = findProjectRoot();
    const expectedCacheMetadata = resolveExpectedRunnerCacheMetadata(device, projectRoot);
    const derived = resolveRunnerDerivedPath(device, expectedCacheMetadata);
    const existing = await evaluateExistingXctestrun({ derived, expectedCacheMetadata });
    return existing.reason === 'reuse_ready';
  } catch {
    return false;
  }
}

type XctestrunCandidate = {
  path: string;
  mtimeMs: number;
};

export function findXctestrun(root: string, device?: DeviceInfo): string | null {
  const candidates = collectXctestrunCandidates(root);
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => compareXctestrunCandidates(left, right, device));
  return candidates[0]?.path ?? null;
}

function collectXctestrunCandidates(root: string): XctestrunCandidate[] {
  if (!fs.existsSync(root)) return [];
  const candidates: XctestrunCandidate[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.xctestrun')) {
        try {
          const stat = fs.statSync(full);
          candidates.push({ path: full, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    }
  }
  return candidates;
}

function compareXctestrunCandidates(
  left: XctestrunCandidate,
  right: XctestrunCandidate,
  device: DeviceInfo | undefined,
): number {
  if (device) {
    const scoreDiff =
      scoreXctestrunCandidate(right.path, device) - scoreXctestrunCandidate(left.path, device);
    if (scoreDiff !== 0) return scoreDiff;
  }
  return right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path);
}

export function scoreXctestrunCandidate(candidatePath: string, device: DeviceInfo): number {
  let score = 0;
  const normalizedPath = candidatePath.toLowerCase();
  const fileName = path.basename(normalizedPath);

  if (fileName.startsWith('agentdevicerunner.env.')) {
    score -= 1_000;
  }

  if (normalizedPath.includes(`${path.sep}macos${path.sep}`)) {
    score -= 5_000;
  }

  const platformHints = resolveRunnerXctestrunHints(device);
  if (platformHints.preferred.length > 0) {
    if (platformHints.preferred.some((hint) => normalizedPath.includes(hint))) {
      score += 2_000;
    } else {
      score -= 500;
    }
  }

  if (platformHints.disallowed.some((hint) => normalizedPath.includes(hint))) {
    score -= 2_500;
  }

  return score;
}

async function buildRunnerXctestrun(
  device: DeviceInfo,
  projectPath: string,
  derived: string,
  options: RunnerXctestrunBuildOptions,
  /** What {@link requireRunnerPhaseRemainingMs} left of the build phase, for the exec layer. */
  buildTimeoutMs: number | undefined,
): Promise<void> {
  // Read immediately before the spawn: a build retried after its first child was killed by a
  // teardown or a last-waiter cancellation reaches this same line again, and admission is what
  // refuses it. Checking at registration would be a check after the child exists (#3220).
  assertRunnerStartAdmitsPreparation(device.id, options.startAdmission);
  const runnerBundleBuildSettings = resolveRunnerBundleBuildSettings(process.env);
  const signingBuildSettings = resolveRunnerSigningBuildSettings(
    process.env,
    device.kind === 'device',
    device,
  );
  const provisioningArgs = device.kind === 'device' ? ['-allowProvisioningUpdates'] : [];
  const performanceBuildSettings = resolveRunnerPerformanceBuildSettings();
  const archBuildSettings = resolveRunnerArchBuildSettings(process.env);
  const sandboxBuildArgs = resolveRunnerSandboxBuildArgs();
  try {
    await runCmdStreaming(
      'xcodebuild',
      [
        'build-for-testing',
        '-project',
        projectPath,
        '-scheme',
        'AgentDeviceRunner',
        '-parallel-testing-enabled',
        'NO',
        resolveRunnerMaxConcurrentDestinationsFlag(device),
        '1',
        ...xcodebuildDestinationArgs(device, resolveRunnerBuildDestination(device)),
        '-derivedDataPath',
        derived,
        ...resolveRunnerBuildLocationSettings(derived),
        ...performanceBuildSettings,
        ...archBuildSettings,
        ...sandboxBuildArgs,
        ...runnerBundleBuildSettings,
        ...provisioningArgs,
        ...signingBuildSettings,
      ],
      {
        detached: true,
        timeoutMs: buildTimeoutMs,
        signal: options.budget?.signal,
        onSpawn: (child) => {
          registerRunnerPrepProcess(device.id, child, options.startAdmission);
        },
        onStdoutChunk: (chunk) => {
          logChunk(chunk, options.logPath, options.traceLogPath, options.verbose);
        },
        onStderrChunk: (chunk) => {
          logChunk(chunk, options.logPath, options.traceLogPath, options.verbose);
        },
      },
    );
  } catch (error) {
    if (isRequestCanceledError(error)) throw error;
    const appErr =
      error instanceof AppError ? error : new AppError('COMMAND_FAILED', String(error));
    const simulatorSet = runnerSimulatorSetFailureDetails(device);
    // The reason and the hint beside it come from one classifier (#2680), so the reason a caller
    // switches on can never disagree with the advice it is handed.
    const { reason, hint, matched } = classifyRunnerStartupFailure(
      new AppError(appErr.code, appErr.message, { ...appErr.details, ...simulatorSet }),
    );
    const hostDeadlineHit = isCommandTimeoutError(appErr);
    // `startupRuleMatched` travels with the verdict: this wrapper buries the tool's text a level too
    // deep for the rows to read again, and whether a row spoke is not recoverable from the reason
    // alone (#2690 review). The device's own state is attached further out, by the startup catch that
    // can see this build and the launch after it.
    const message = 'xcodebuild build-for-testing failed';
    throw new AppError(
      'COMMAND_FAILED',
      reason === 'simulator_set_destination_not_found'
        ? simulatorSetDestinationNotFoundMessage(message, device, simulatorSet)
        : message,
      {
        reason,
        error: appErr.message,
        details: appErr.details,
        logPath: options.logPath,
        hint,
        startupRuleMatched: matched,
        startupHostDeadlineHit: hostDeadlineHit,
        ...simulatorSet,
      },
    );
  }
}
