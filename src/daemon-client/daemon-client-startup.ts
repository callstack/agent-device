import fs from 'node:fs';
import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { processLockHoldsDaemonIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import { inspectProcessLock, type ProcessLockInspection } from '@agent-device/host-kit/file';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { sleep } from '@agent-device/host-kit/retry';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { type ExecDetachedExit } from '@agent-device/host-kit/command';
import {
  DAEMON_STARTUP_EXIT_CODES,
  readDaemonStartupPhaseMarkers,
  recoverAbandonedDaemonRegistration,
  removeDaemonStartupPhasesFile,
  resolveDaemonStartupPhasesPath,
  type DaemonRetirementResult,
  type DaemonStartupPhase,
  launchDaemonProcess,
  stopAndRetireDaemon,
  type DaemonStartupLaunch,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import type {
  DaemonPaths,
  DaemonTransportPreference,
} from '@agent-device/daemon-contracts/daemon-resolution';
import {
  resolveDaemonLaunchSpec,
  resolveDaemonTakeover,
  type DaemonTakeoverDecision,
} from './daemon-launch-spec.ts';
import {
  getDaemonMetadataState,
  readDaemonInfo,
  resolveDaemonStartupHint,
  type DaemonInfo,
} from './daemon-client-metadata.ts';
import { canConnect, isDaemonTransportUnavailableError } from './daemon-client-transport.ts';
import {
  daemonContendedError,
  daemonRetirementUnconfirmedError,
  daemonStopCommand,
} from './daemon-lifecycle-errors.ts';
import type { DaemonClientSettings, EnsuredDaemon } from './daemon-client-lifecycle.ts';

/** Whether the daemon a state dir registered is reusable by this client, and what to do if not. */
type LocalDaemonObservation = {
  info: DaemonInfo;
  decision: DaemonTakeoverDecision;
};

type DaemonStartupWaitResult =
  | { kind: 'ready'; daemon: EnsuredDaemon }
  | { kind: 'early_exit'; exit: ExecDetachedExit }
  | { kind: 'unproven'; error: AppError }
  | { kind: 'retry' | 'timeout' }
  /** The process stayed alive but published no new startup phase within the stall window. */
  | { kind: 'stalled' }
  /** The process stayed alive and kept progressing, but did not register before the ceiling. */
  | { kind: 'ceiling' };

/** Startup phase markers one launch published, as absolute host-clock timestamps. */
type StartupPhaseObservation = {
  spawnedAtMs: number;
  markers: Partial<Record<DaemonStartupPhase, number>>;
};

/**
 * #3782: the ceiling on one local daemon startup, shared by the CLI, MCP, and Node client, because
 * all three reach the daemon through `startLocalDaemon`. A slow host makes startup slower, not
 * failed: while the spawned daemon stays alive and keeps publishing phase markers, the client keeps
 * waiting. `AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS` overrides the ceiling for a caller that must
 * fail sooner than the host allows.
 */
const DAEMON_STARTUP_CEILING_MS = 120_000;
/**
 * How long a live daemon may publish no new startup phase marker before the client stops waiting.
 * Kept beside the ceiling as one pair: a stalled daemon is retired at the stall window, a
 * progressing one is waited for up to the ceiling. An env ceiling below this window makes the
 * ceiling the only stop; the stall never fires past the ceiling, only earlier than it.
 */
const DAEMON_STARTUP_STALL_WINDOW_MS = 60_000;
const MINIMUM_DAEMON_TAKEOVER_BUDGET_MS = 5_000;

const DAEMON_STARTUP_TIMEOUT_ENV = 'AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS';

/** Why a startup that never reached readiness failed, in terms a caller can branch on (#3782). */
type DaemonStartupFailureReason = 'startup-exited' | 'startup-stalled' | 'startup-ceiling';

function resolveDaemonStartupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DAEMON_STARTUP_TIMEOUT_ENV]?.trim();
  if (raw === undefined || raw === '') return DAEMON_STARTUP_CEILING_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(
      'INVALID_ARGS',
      `${DAEMON_STARTUP_TIMEOUT_ENV} must be a positive integer number of milliseconds`,
      { value: raw },
    );
  }
  return parsed;
}

const LIVE_DAEMON_PROBE_RETRIES = 3;
const LIVE_DAEMON_PROBE_RETRY_DELAY_MS = 200;
const DAEMON_STARTUP_ATTEMPTS = 2;
const DAEMON_STARTUP_LOG_TAIL_BYTES = 64_000;
const DAEMON_STARTUP_MARKER_TAIL_BYTES = 16_000;

/**
 * Reads the registered daemon and judges it against this client, changing nothing. Whether the
 * judgement is acted on belongs to the caller's lifecycle: a managed client replaces, an attach
 * client reports, `ensureDaemon` replaces only through a quiesce.
 */
export async function observeLocalDaemon(
  settings: DaemonClientSettings,
  options: {
    deadline?: number;
    waitForLiveStartup?: boolean;
    /** Tell a live daemon on another transport from one that answers nowhere. */
    refineUnreachable?: boolean;
  } = {},
): Promise<LocalDaemonObservation | null> {
  const { deadline } = options;
  const inspection = inspectProcessLock(settings.paths.lockPath);
  if (inspection.state === 'unproven') throw daemonRegistrationUnprovenError(settings, inspection);
  const existing = readDaemonInfo(settings.paths.infoPath);
  if (!existing) return null;
  if (!registrationAllowsDaemonObservation(inspection, existing)) return null;
  if (options.waitForLiveStartup && (await isAwaitingDaemonStartup(existing, deadline)))
    return null;

  const decision = await resolveDaemonTakeover(existing, {
    onClientTransport: () =>
      canReachReusableDaemon(existing, settings.transportPreference, deadline),
    onAnyAdvertisedTransport: () => canReachReusableDaemon(existing, 'auto', deadline),
  });
  return { info: existing, decision: await refineReplacement(existing, decision, options) };
}

/**
 * Tells apart what the ladder lumps together, for callers that must not kill a daemon on a guess: a
 * registration whose process is gone is unreachable whatever its version, and one that answers on
 * another transport is alive.
 */
async function refineReplacement(
  info: DaemonInfo,
  decision: DaemonTakeoverDecision,
  options: { deadline?: number; refineUnreachable?: boolean },
): Promise<DaemonTakeoverDecision> {
  if (!options.refineUnreachable || decision.kind !== 'replace') return decision;
  if (!isProcessAlive(info.pid)) return { ...decision, cause: 'unreachable' };
  if (
    decision.cause === 'unreachable' &&
    (await canReachReusableDaemon(info, 'auto', options.deadline))
  ) {
    return { ...decision, cause: 'transport' };
  }
  return decision;
}

export async function readReusableLocalDaemon(
  settings: DaemonClientSettings,
  options: { deadline?: number; waitForLiveStartup?: boolean } = {},
): Promise<DaemonInfo | null> {
  const { deadline } = options;
  const observed = await observeLocalDaemon(settings, options);
  if (!observed) return null;
  const { info: existing, decision } = observed;
  if (decision.kind === 'reuse') return existing;
  if (decision.kind === 'refuseNewer') {
    throw newerDaemonRefusedError(existing, decision, settings.paths.baseDir);
  }

  if (!settings.retireIncompatibleContender) throw daemonContendedError();
  if (remainingStartupBudget(deadline) < MINIMUM_DAEMON_TAKEOVER_BUDGET_MS) return null;
  emitDaemonTakeoverNotice(existing, decision.reason, settings.paths.baseDir);
  await retireDaemonForTakeover(existing, settings.paths);
  return null;
}

async function isAwaitingDaemonStartup(
  info: DaemonInfo,
  deadline: number | undefined,
): Promise<boolean> {
  return (
    isProcessAlive(info.pid) && !(await canConnect(info, 'auto', remainingStartupBudget(deadline)))
  );
}

function registrationAllowsDaemonObservation(
  inspection: ProcessLockInspection,
  info: DaemonInfo,
): boolean {
  return (
    inspection.state === 'absent' ||
    processLockHoldsDaemonIdentity(inspection, {
      pid: info.pid,
      startTime: info.processStartTime ?? null,
    })
  );
}

function daemonRegistrationUnprovenError(
  settings: DaemonClientSettings,
  inspection?: ProcessLockInspection,
): AppError {
  return new AppError('COMMAND_FAILED', 'Daemon registration ownership could not be verified.', {
    reason: 'daemon_registration_unproven',
    inspection,
    stateDir: settings.paths.baseDir,
    hint: resolveDaemonStartupHint(getDaemonMetadataState(settings.paths), settings.paths),
  });
}

export async function stopDaemonForTakeover(
  existing: DaemonInfo,
  paths: DaemonPaths,
  mode: 'graceful' | 'force' = 'graceful',
): Promise<DaemonRetirementResult> {
  return await stopAndRetireDaemon({
    paths: paths,
    observed: { pid: existing.pid, startTime: existing.processStartTime ?? null },
    mode,
  });
}

export async function retireDaemonForTakeover(
  existing: DaemonInfo,
  paths: DaemonPaths,
  mode: 'graceful' | 'force' = 'graceful',
): Promise<void> {
  const retirement = await stopDaemonForTakeover(existing, paths, mode);
  if (retirement.status === 'retained') throw daemonRetirementUnconfirmedError(retirement, paths);
}

/**
 * A daemon whose pid is still alive is probed again before it can be judged unreachable. A probe's
 * budget is wall-clock time on this client's event loop, so a client that stalls past it (a large
 * synchronous parse, a GC pause on a loaded host) reads a listening daemon as unreachable, and
 * replacing it ends every session the daemon holds. Liveness is the signal-0 check, not the `ps`
 * identity read: under the load that stalls the probe, `ps` misses its deadline too, and the
 * takeover still proves identity before it signals anything.
 */
async function canReachReusableDaemon(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
  deadline?: number,
): Promise<boolean> {
  if (await canConnectReusableDaemon(info, preference, deadline)) return true;
  for (let retry = 1; retry <= LIVE_DAEMON_PROBE_RETRIES; retry += 1) {
    if (!isProcessAlive(info.pid) || (deadline !== undefined && Date.now() >= deadline))
      return false;
    await sleep(Math.min(LIVE_DAEMON_PROBE_RETRY_DELAY_MS, remainingStartupBudget(deadline)));
    if (await canConnectReusableDaemon(info, preference, deadline)) {
      emitDiagnostic({
        level: 'warn',
        phase: 'daemon_probe_recovered',
        data: { pid: info.pid, retry },
      });
      return true;
    }
  }
  return false;
}

/**
 * ADR 0029: a caller that names a daemon policy must not silently use a daemon that enforces a
 * different one (or none). A caller that names no policy uses whatever the daemon enforces.
 */
export async function assertDaemonPolicyMatches(
  existing: DaemonInfo,
  stateDir: string,
): Promise<void> {
  if (!process.env.AGENT_DEVICE_DAEMON_POLICY?.trim()) return;
  const { loadDaemonPolicy } = await import('@agent-device/daemon-contracts/daemon-policy-file');
  const expected = loadDaemonPolicy(process.env)?.digest;
  if (expected === existing.policyDigest) return;
  throw new AppError(
    'COMMAND_FAILED',
    'The running daemon does not enforce the daemon policy named by AGENT_DEVICE_DAEMON_POLICY.',
    {
      reason: 'DAEMON_POLICY_MISMATCH',
      expectedPolicyDigest: expected,
      daemonPolicyDigest: existing.policyDigest ?? null,
      hint: `Stop the running daemon (${daemonStopCommand(stateDir)}), then retry so a daemon starts with this policy.`,
    },
  );
}

async function canConnectReusableDaemon(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
  deadline?: number,
): Promise<boolean> {
  try {
    return await canConnect(info, preference, remainingStartupBudget(deadline));
  } catch (error) {
    if (isDaemonTransportUnavailableError(error)) return false;
    throw error;
  }
}

function newerDaemonRefusedError(
  info: DaemonInfo,
  decision: Extract<DaemonTakeoverDecision, { kind: 'refuseNewer' }>,
  stateDir: string,
): AppError {
  const { daemonVersion, clientVersion } = decision;
  return new AppError(
    'COMMAND_FAILED',
    `Daemon (pid ${info.pid}, v${daemonVersion}) is newer than this client (v${clientVersion}); refusing to replace it.`,
    {
      daemonPid: info.pid,
      daemonVersion,
      clientVersion,
      hint: `Use the agent-device v${daemonVersion} CLI that started it, or stop it deliberately: ${daemonStopCommand(stateDir)}`,
    },
  );
}

function emitDaemonTakeoverNotice(info: DaemonInfo, reason: string, stateDir: string): void {
  try {
    const identity = info.version ? `pid ${info.pid}, v${info.version}` : `pid ${info.pid}`;
    process.stderr.write(`Replacing daemon (${identity}) in ${stateDir}: ${reason}\n`);
  } catch {
    // The takeover notice is best effort; never fail the command on stderr issues.
  }
}

type FailedDaemonStartup = {
  cleanup?: DaemonRetirementResult;
  startError?: string;
  startupError?: NormalizedError;
  daemonProcess?: ExecDetachedExit | { pid: number };
  retry: boolean;
  /** Set when the wait ended on startup progress rather than on an exit or a race. */
  reason?: DaemonStartupFailureReason;
  phases?: StartupPhaseObservation;
};

export async function startLocalDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  const startupTimeoutMs = resolveDaemonStartupTimeoutMs();
  const deadline = Date.now() + startupTimeoutMs;
  const cleanupResults: DaemonRetirementResult[] = [];
  let failure: FailedDaemonStartup | undefined;
  let attempts = 0;
  while (attempts < DAEMON_STARTUP_ATTEMPTS && Date.now() < deadline) {
    attempts += 1;
    const result = await attemptLocalDaemonStartup(settings, deadline);
    if ('daemon' in result) return result.daemon;
    failure = result;
    if (result.cleanup) cleanupResults.push(result.cleanup);
    if (!result.retry) break;
    await sleep(Math.min(150, Math.max(0, deadline - Date.now())));
  }
  const { startError, startupError, daemonProcess, reason, phases }: Partial<FailedDaemonStartup> =
    failure ?? {};
  const effectiveReason: DaemonStartupFailureReason = reason ?? 'startup-exited';
  const state = getDaemonMetadataState(settings.paths);
  const daemonLogTail = readRecentLogTail(settings.paths.logPath);
  throw new AppError('COMMAND_FAILED', 'Failed to start daemon', {
    kind: 'daemon_startup_failed',
    reason: effectiveReason,
    stateDir: settings.paths.baseDir,
    infoPath: settings.paths.infoPath,
    lockPath: settings.paths.lockPath,
    logPath: settings.paths.logPath,
    startupTimeoutMs,
    startupAttempts: attempts,
    cleanupResults,
    startError,
    startupError,
    daemonProcess,
    ...(phases ? { phases: describeStartupPhaseTimings(phases) } : {}),
    ...(daemonLogTail ? { daemonLogTail } : {}),
    metadataState: state,
    hint:
      reason === 'startup-stalled' || reason === 'startup-ceiling'
        ? resolveStartupProgressHint(reason, startupTimeoutMs)
        : resolveDaemonStartupHint(state, settings.paths),
  });
}

async function attemptLocalDaemonStartup(
  settings: DaemonClientSettings,
  deadline: number,
): Promise<{ daemon: EnsuredDaemon } | FailedDaemonStartup> {
  let launch: DaemonStartupLaunch;
  const spawnedAtMs = Date.now();
  try {
    launch = startDaemon(settings);
  } catch (error) {
    return await recoverFailedDaemonLaunch(settings, error);
  }
  const observation: StartupPhaseObservation = { spawnedAtMs, markers: {} };
  const startup = await waitForDaemonStartup(deadline, settings, launch, observation);
  if (startup.kind === 'ready') return { daemon: startup.daemon };
  refreshStartupPhaseMarkers(settings, launch.pid, observation);
  if (startup.kind === 'retry') return { retry: true, phases: observation };
  if (startup.kind === 'unproven') {
    const startupError = normalizeError(startup.error);
    return {
      retry: false,
      startError: startupError.message,
      startupError,
      daemonProcess: { pid: launch.pid },
      phases: observation,
    };
  }
  const { cleanup, joined } = await retireStartupAttempt(settings, launch, deadline);
  const reason: DaemonStartupFailureReason =
    startup.kind === 'stalled'
      ? 'startup-stalled'
      : startup.kind === 'ceiling'
        ? 'startup-ceiling'
        : 'startup-exited';
  const available = isRegistrationAvailable(inspectProcessLock(settings.paths.lockPath));
  return {
    cleanup,
    retry: joined && startup.kind === 'early_exit' && available,
    reason,
    startError: startup.kind === 'early_exit' ? describeDaemonEarlyExit(startup.exit) : undefined,
    daemonProcess: startup.kind === 'early_exit' ? startup.exit : { pid: launch.pid },
    phases: observation,
  };
}

async function recoverFailedDaemonLaunch(
  settings: DaemonClientSettings,
  error: unknown,
): Promise<FailedDaemonStartup> {
  const cleanup = settings.ownedStateDir
    ? await stopAndRetireDaemon({
        paths: settings.paths,
        observed: null,
        mode: 'graceful',
        ownedStateDir: settings.ownedStateDir,
        lockTimeoutMs: 0,
      })
    : await recoverAbandonedDaemonRegistration({
        paths: settings.paths,
        observed: null,
        lockTimeoutMs: 0,
      });
  return {
    cleanup,
    startError: normalizeError(error).message,
    retry: !settings.ownedStateDir && cleanup.status !== 'retained',
  };
}

async function retireStartupAttempt(
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
  deadline: number,
): Promise<{ cleanup: DaemonRetirementResult; joined: boolean }> {
  const cleanup = await stopAndRetireDaemon({
    paths: settings.paths,
    observed: launch.readIdentity(),
    mode: 'graceful',
    ownedStateDir: settings.ownedStateDir,
    termTimeoutMs: Math.min(3_000, remainingStartupBudget(deadline)),
    killTimeoutMs: 1_000,
    lockTimeoutMs: 0,
  });
  const joined = await joinStartup(launch);
  // The launch's exit is joined, so nothing can append to its marker file anymore, and the file
  // has served its last purpose (the failure record carries the phases). Removing it here is what
  // keeps a retired startup's evidence from becoming state-dir residue. Without a joined exit the
  // file stays: its writer may still be alive, and only that writer or a later joined exit owns it.
  if (joined)
    removeDaemonStartupPhasesFile(
      resolveDaemonStartupPhasesPath(settings.paths.baseDir, launch.pid),
    );
  return { cleanup, joined };
}

async function joinStartup(launch: DaemonStartupLaunch): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      launch.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function remainingStartupBudget(deadline?: number): number {
  return deadline === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadline - Date.now());
}

function isRegistrationAvailable(inspection: ProcessLockInspection): boolean {
  return (
    inspection.state === 'absent' ||
    (inspection.state === 'held' &&
      (inspection.liveness === 'owner-process-dead' ||
        inspection.liveness === 'owner-process-reused'))
  );
}

async function waitForDaemonStartup(
  deadline: number,
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
  observation: StartupPhaseObservation,
): Promise<DaemonStartupWaitResult> {
  let earlyExit: ExecDetachedExit | undefined;
  void launch.exited.then((exit) => {
    earlyExit = exit;
  });
  while (Date.now() < deadline) {
    if (earlyExit) {
      const settled = await judgeExitedDaemonStartup(settings, earlyExit, deadline);
      if (settled) return settled;
    } else {
      const settled = await observeLiveDaemonStartup(settings, launch, deadline, observation);
      // An exit observed while this iteration was in flight outranks a `ready` read: the process
      // that published is gone, and its classification owns the next step.
      if (settled && !(settled.kind === 'ready' && earlyExit)) return settled;
    }
    await sleep(Math.min(100, remainingStartupBudget(deadline)));
  }
  if (earlyExit || !isProcessAlive(launch.pid)) return { kind: 'timeout' };
  // A live daemon at the ceiling registered late, not never: only its retirement is this deadline's
  // failure, and the reason says the host, not the daemon, ran out of room.
  return { kind: 'ceiling' };
}

async function judgeExitedDaemonStartup(
  settings: DaemonClientSettings,
  exit: ExecDetachedExit,
  deadline: number,
): Promise<DaemonStartupWaitResult | null> {
  const kind = classifyDaemonStartupExit(exit);
  if (kind === 'unproven')
    return { kind: 'unproven', error: daemonRegistrationUnprovenError(settings) };
  if (kind === 'failed') return { kind: 'early_exit', exit };
  return await observeContendingDaemon(settings, deadline);
}

async function observeLiveDaemonStartup(
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
  deadline: number,
  observation: StartupPhaseObservation,
): Promise<DaemonStartupWaitResult | null> {
  const info = await readReadyLaunchedDaemon(settings, launch, deadline);
  if (info) return { kind: 'ready', daemon: { info, startedByClient: true } };
  // #3782: a live daemon that keeps publishing startup markers is slow, not stuck, and is
  // waited for up to the ceiling. Only silence for a full stall window retires it early.
  refreshStartupPhaseMarkers(settings, launch.pid, observation);
  if (
    isProcessAlive(launch.pid) &&
    Date.now() - lastStartupProgressMs(observation) >= DAEMON_STARTUP_STALL_WINDOW_MS
  ) {
    return { kind: 'stalled' };
  }
  return null;
}

/**
 * #3782: folds this launch's startup phase markers into `observation`. The record is one launch's
 * own file, named for the pid that wrote it, so no other launch's evidence can add to or hide it.
 */
function refreshStartupPhaseMarkers(
  settings: DaemonClientSettings,
  launchPid: number,
  observation: StartupPhaseObservation,
): void {
  const tail = readRecentFileTail(
    resolveDaemonStartupPhasesPath(settings.paths.baseDir, launchPid),
    DAEMON_STARTUP_MARKER_TAIL_BYTES,
  );
  if (!tail) return;
  for (const [phase, timestampMs] of Object.entries(readDaemonStartupPhaseMarkers(tail)) as Array<
    [DaemonStartupPhase, number]
  >) {
    observation.markers[phase] = timestampMs;
  }
}

function lastStartupProgressMs(observation: StartupPhaseObservation): number {
  return Object.values(observation.markers).reduce(
    (latest, timestampMs) => Math.max(latest, timestampMs),
    observation.spawnedAtMs,
  );
}

function describeStartupPhaseTimings(
  observation: StartupPhaseObservation,
): Record<string, number> & { spawned: 0 } {
  const timings: Record<string, number> = { spawned: 0 };
  for (const [phase, timestampMs] of Object.entries(observation.markers)) {
    timings[phase] = Math.max(0, timestampMs - observation.spawnedAtMs);
  }
  return timings as Record<string, number> & { spawned: 0 };
}

function resolveStartupProgressHint(reason: DaemonStartupFailureReason, ceilingMs: number): string {
  if (reason === 'startup-stalled') {
    return (
      `The daemon is alive but made no startup progress for ${DAEMON_STARTUP_STALL_WINDOW_MS / 1000} s. ` +
      `The host can be overloaded. Retry once the host load drops; ${DAEMON_STARTUP_TIMEOUT_ENV} ` +
      `raises only the registration ceiling and does not change this stall window.`
    );
  }
  return (
    `The daemon is alive but did not register within ${Math.round(ceilingMs / 1000)} s. ` +
    `The host can be overloaded. Retry, or raise ${DAEMON_STARTUP_TIMEOUT_ENV}.`
  );
}

function classifyDaemonStartupExit(exit: ExecDetachedExit): 'busy' | 'unproven' | 'failed' {
  if (exit.error || exit.signal) return 'failed';
  switch (exit.exitCode) {
    case DAEMON_STARTUP_EXIT_CODES.busy:
      return 'busy';
    case DAEMON_STARTUP_EXIT_CODES.unproven:
      return 'unproven';
    default:
      return 'failed';
  }
}

async function observeContendingDaemon(
  settings: DaemonClientSettings,
  deadline: number,
): Promise<DaemonStartupWaitResult | null> {
  let winner: DaemonInfo | null;
  try {
    winner = await readReusableLocalDaemon(settings, { deadline, waitForLiveStartup: true });
  } catch (error) {
    if (error instanceof AppError && error.details?.reason === 'daemon_registration_unproven')
      return { kind: 'unproven', error };
    throw error;
  }
  if (Date.now() >= deadline) return null;
  if (winner) return { kind: 'ready', daemon: { info: winner, startedByClient: false } };
  const inspection = inspectProcessLock(settings.paths.lockPath);
  if (inspection.state === 'unproven')
    return { kind: 'unproven', error: daemonRegistrationUnprovenError(settings, inspection) };
  return isRegistrationAvailable(inspection) ? { kind: 'retry' } : null;
}

async function readReadyLaunchedDaemon(
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
  deadline: number,
): Promise<DaemonInfo | null> {
  const info = readDaemonInfo(settings.paths.infoPath);
  if (!info || !isLaunchedDaemon(info, launch)) return null;
  try {
    return (await canConnect(
      info,
      settings.transportPreference,
      remainingStartupBudget(deadline),
    )) && Date.now() < deadline
      ? info
      : null;
  } catch (error) {
    const { cleanup, joined } = await retireStartupAttempt(settings, launch, deadline);
    emitDiagnostic({
      level: 'warn',
      phase: 'daemon_startup_observation_failed',
      data: { stateDir: settings.paths.baseDir, cleanup, joined, error: normalizeError(error) },
    });
    if (error instanceof AppError) {
      error.details = {
        ...error.details,
        stateDir: settings.paths.baseDir,
        cleanupResults: [cleanup],
        startupJoined: joined,
      };
    }
    throw error;
  }
}

/** Whether `info` names the daemon process this client launched: same pid and start time. */
function isLaunchedDaemon(info: DaemonInfo, launch: DaemonStartupLaunch): boolean {
  const identity = launch.readIdentity();
  return (
    info.pid === identity.pid &&
    identity.startTime !== null &&
    info.processStartTime === identity.startTime
  );
}

function startDaemon(settings: DaemonClientSettings): DaemonStartupLaunch {
  const launchSpec = resolveDaemonLaunchSpec();
  return launchDaemonProcess({
    paths: settings.paths,
    serverMode: settings.serverMode,
    ownedStateDir: settings.ownedStateDir,
    args: launchSpec.useSrc
      ? ['--experimental-strip-types', launchSpec.srcPath]
      : [launchSpec.distPath],
  });
}

function describeDaemonEarlyExit(exit: ExecDetachedExit): string {
  if (exit.error) return `daemon process ${exit.pid} failed to start: ${exit.error}`;
  if (exit.signal)
    return `daemon process ${exit.pid} exited before readiness with signal ${exit.signal}`;
  return `daemon process ${exit.pid} exited before readiness with code ${exit.exitCode ?? 0}`;
}

function readRecentLogTail(logPath: string): string | undefined {
  return readRecentFileTail(logPath, DAEMON_STARTUP_LOG_TAIL_BYTES);
}

function readRecentFileTail(filePath: string, maxBytes: number): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const stats = fs.statSync(filePath);
    if (stats.size <= 0) return undefined;
    const length = Math.min(stats.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stats.size - length);
      const text = buffer.toString('utf8').trim();
      return text.length > 0 ? text : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
