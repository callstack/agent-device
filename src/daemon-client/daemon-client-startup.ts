import fs from 'node:fs';
import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';
import { processLockHoldsDaemonIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import { inspectProcessLock, type ProcessLockInspection } from '@agent-device/host-kit/file';
import { classifyOwnerLiveness, isProcessAlive } from '@agent-device/host-kit/process';
import { sleep } from '@agent-device/host-kit/retry';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { type ExecDetachedExit } from '@agent-device/host-kit/command';
import {
  DAEMON_STARTUP_EXIT_CODES,
  recoverAbandonedDaemonRegistration,
  type DaemonRetirementResult,
  launchDaemonProcess,
  stopAndRetireDaemon,
  type DaemonStartupLaunch,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  readDaemonStartupPhaseMarkers,
  removeDaemonStartupPhasesFile,
  resolveDaemonStartupPhasesPath,
  type DaemonStartupPhase,
} from '@agent-device/daemon-contracts/daemon-startup-phases';
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
  observedDaemonIdentityOf,
  readDaemonInfo,
  resolveDaemonStartupHint,
  type DaemonInfo,
} from './daemon-client-metadata.ts';
import { canConnect, isDaemonTransportUnavailableError } from './daemon-client-transport.ts';
import {
  daemonContendedError,
  daemonNotRetirableError,
  daemonRecordOwnerUnrecognizedError,
  daemonRetirementUnconfirmedError,
  daemonStopCommand,
} from './daemon-lifecycle-errors.ts';
import type { DaemonClientSettings, EnsuredDaemon } from './daemon-client-lifecycle.ts';

type LocalDaemonObservation = {
  info: DaemonInfo;
  decision: DaemonTakeoverDecision;
};

type DaemonStartupWaitResult =
  | { kind: 'ready'; daemon: EnsuredDaemon }
  | { kind: 'early_exit'; exit: ExecDetachedExit }
  | { kind: 'unproven'; error: AppError }
  | { kind: 'retry' }
  | { kind: 'exit_unobserved' }
  | { kind: 'stalled' }
  | { kind: 'ceiling' };

type StartupPhaseObservation = {
  spawnedAtMs: number;
  markers: Partial<Record<DaemonStartupPhase, number>>;
};

/** The ceiling on one local daemon startup; `AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS` overrides it. */
const DAEMON_STARTUP_CEILING_MS = 120_000;
/** Silence this long ends the wait early; an env ceiling below it makes the ceiling the stop. */
const DAEMON_STARTUP_STALL_WINDOW_MS = 60_000;
const MINIMUM_DAEMON_TAKEOVER_BUDGET_MS = 5_000;

const DAEMON_STARTUP_TIMEOUT_ENV = 'AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS';

type DaemonStartupFailureReason = 'startup-exited' | 'startup-stalled' | 'startup-ceiling';

function resolveDaemonStartupTimeoutMs(env: Readonly<EnvMap>): number {
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

/** Judges the registered daemon against this client, changing nothing. */
export async function observeLocalDaemon(
  settings: DaemonClientSettings,
  options: {
    deadline?: number;
    waitForLiveStartup?: boolean;
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
  // A host owns an embedded runtime, so a managed client that wants this state directory asks the host
  // for it instead of retiring the runtime that holds it.
  if (existing.ownership === 'embedded') {
    throw daemonNotRetirableError({
      info: existing,
      stateDir: settings.paths.baseDir,
    });
  }
  // A record stating an owner this build cannot read is not a licence to replace what it names: the
  // whole point of reading the owner is to know whether a pid may be signaled, and this says nothing.
  if (existing.ownership === 'unknown') {
    throw daemonRecordOwnerUnrecognizedError({
      info: existing,
      stateDir: settings.paths.baseDir,
    });
  }
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
    observed: observedDaemonIdentityOf(existing),
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

/** A live pid is probed again before being judged unreachable; liveness is signal 0, not `ps`. */
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
  host: HostEnvironment,
): Promise<void> {
  const { env } = host;
  if (!env.AGENT_DEVICE_DAEMON_POLICY?.trim()) return;
  const { loadDaemonPolicy } = await import('@agent-device/daemon-contracts/daemon-policy-file');
  const expected = loadDaemonPolicy(env, host.cwd)?.digest;
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
  } catch {}
}

type FailedDaemonStartup = {
  cleanup?: DaemonRetirementResult;
  startError?: string;
  startupError?: NormalizedError;
  daemonProcess?: ExecDetachedExit | { pid: number };
  retry: boolean;
  reason?: DaemonStartupFailureReason;
  phases?: StartupPhaseObservation;
};

export async function startLocalDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  const startupTimeoutMs = resolveDaemonStartupTimeoutMs(settings.host.env);
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
  if (startup.kind === 'ready') {
    // Winner readiness (startedByClient false) is only reachable after this launch exited busy:
    // its own record is this client's to sweep before the handoff.
    if (!startup.daemon.startedByClient) await discardExitedLaunchRecord(settings, launch);
    return { daemon: startup.daemon };
  }
  refreshStartupPhaseMarkers(settings, launch.pid, observation);
  if (startup.kind === 'retry') {
    await discardExitedLaunchRecord(settings, launch);
    return { retry: true, phases: observation };
  }
  if (startup.kind === 'unproven') {
    await discardExitedLaunchRecord(settings, launch);
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
    observed: { ...launch.readIdentity(), ownership: 'detached' as const },
    mode: 'graceful',
    ownedStateDir: settings.ownedStateDir,
    termTimeoutMs: Math.min(3_000, remainingStartupBudget(deadline)),
    killTimeoutMs: 1_000,
    lockTimeoutMs: 0,
  });
  const joined = await joinStartup(launch);
  // A joined exit is what licenses removing the record; without it the file stays.
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

/** Sweeps a proven-exited launch's own record after joining that exact child. */
async function discardExitedLaunchRecord(
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
): Promise<void> {
  if (await joinStartup(launch)) {
    removeDaemonStartupPhasesFile(
      resolveDaemonStartupPhasesPath(settings.paths.baseDir, launch.pid),
    );
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
      // An in-flight exit outranks a `ready` read: the publisher is gone.
      if (settled && !(settled.kind === 'ready' && earlyExit)) return settled;
    }
    await sleep(Math.min(100, remainingStartupBudget(deadline)));
  }
  return classifyExpiredDaemonStartup(settings, launch, earlyExit);
}

/** Judges the wait at an expired deadline; never signals anything. */
function classifyExpiredDaemonStartup(
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
  earlyExit: ExecDetachedExit | undefined,
): DaemonStartupWaitResult {
  // A live lock owner outranks an observed exit; a delivered exit is authoritative for its lifetime.
  const liveLockOwner = isLiveLockOwner(inspectProcessLock(settings.paths.lockPath));
  if (liveLockOwner) return { kind: 'ceiling' };
  if (earlyExit) return { kind: 'early_exit', exit: earlyExit };
  return isLiveLaunchedStartup(launch) ? { kind: 'ceiling' } : { kind: 'exit_unobserved' };
}

function isLiveLaunchedStartup(launch: DaemonStartupLaunch): boolean {
  if (!isProcessAlive(launch.pid)) return false;
  const identity = launch.readIdentity();
  if (!identity.startTime) return true;
  return classifyOwnerLiveness({ owner: identity }) !== 'owner-process-reused';
}

/** A lock owner is a pending startup unless provably dead or reused. */
function isLiveLockOwner(inspection: ProcessLockInspection): boolean {
  return (
    inspection.state === 'held' &&
    inspection.liveness !== 'owner-process-dead' &&
    inspection.liveness !== 'owner-process-reused'
  );
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
  refreshStartupPhaseMarkers(settings, launch.pid, observation);
  if (
    isProcessAlive(launch.pid) &&
    Date.now() - lastStartupProgressMs(observation) >= DAEMON_STARTUP_STALL_WINDOW_MS
  ) {
    return { kind: 'stalled' };
  }
  return null;
}

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

function describeStartupPhaseTimings(observation: StartupPhaseObservation): Record<string, number> {
  const timings: Record<string, number> = { spawned: 0 };
  for (const [phase, timestampMs] of Object.entries(observation.markers)) {
    timings[phase] = Math.max(0, timestampMs - observation.spawnedAtMs);
  }
  return timings;
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
    env: settings.host.env,
    cwd: settings.host.cwd,
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
