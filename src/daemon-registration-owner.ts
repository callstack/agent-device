import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCmdDetachedMonitored, type ExecDetachedExit } from '@agent-device/host-kit/command';
import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import {
  stopDaemonProcess,
  waitForDaemonExit,
  type DaemonTerminationResult,
} from './daemon-process.ts';
import {
  readCurrentOwnerIdentity,
  readProcessStartTime,
  type OwnerIdentity,
} from '@agent-device/host-kit/process';
import {
  publishFileSync,
  inspectProcessLock,
  tryAcquireProcessLock,
  acquireProcessLockAcquisition,
  type ProcessLockAttempt,
  type ProcessLockAcquisition,
} from '@agent-device/host-kit/file';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { withDaemonDiagnosticsScope } from './daemon-diagnostics-scope.ts';
import type { DaemonCodeOrigin } from '@agent-device/host-kit/code-signature';
import {
  resolveDaemonPaths,
  type DaemonPaths,
  type DaemonServerMode,
} from './daemon-resolution.ts';
import { findUnrecoveredRepairCommitFailure } from './session-repair-tombstone.ts';
import {
  processLockHoldsDaemonIdentity,
  readRegisteredDaemonOwnership,
  readRegisteredDaemonIdentity,
  type RegisteredDaemonOwnership,
} from './daemon-registration.ts';
import {
  buildDaemonShutdownReport,
  resolveDaemonShutdownReportPath,
  type DaemonShutdownOutcome,
} from './daemon-shutdown-report.ts';

export const DAEMON_STARTUP_EXIT_CODES = Object.freeze({ busy: 75, unproven: 78 });
export type DaemonRegistrationFields = Readonly<{
  socketPort?: number;
  httpPort?: number;
  token: string;
  version: string;
  codeOrigin: DaemonCodeOrigin;
  codeSignature: string;
  policyDigest?: string;
}>;
type DaemonRegistrationRemoval =
  | Readonly<{ state: 'removed' }>
  | Exclude<RegisteredDaemonOwnership, { state: 'match' }>;
export type DaemonRegistrationOwner = Readonly<{
  publish(fields: DaemonRegistrationFields): void;
  finish(outcome?: DaemonShutdownOutcome): Promise<DaemonRegistrationRemoval>;
}>;

export async function tryAcquireDaemonRegistration(
  paths: DaemonPaths,
): Promise<
  | Readonly<{ status: 'acquired'; owner: DaemonRegistrationOwner }>
  | Exclude<ProcessLockAttempt, { status: 'acquired' }>
> {
  const boundPaths = { ...paths };
  const identity = readCurrentOwnerIdentity();
  const attempt = tryAcquireProcessLock({
    lockDirPath: boundPaths.lockPath,
    owner: { ...identity, acquiredAtMs: Date.now() },
    description: 'daemon registration',
  });
  if (attempt.status !== 'acquired') return attempt;
  const { acquisition } = attempt;
  try {
    acquisition.assertHeld();
    fs.rmSync(resolveDaemonShutdownReportPath(boundPaths.baseDir), { force: true });
  } catch (error) {
    await releaseRegistrationAfterFailure(acquisition, error, boundPaths.logPath);
  }
  return {
    status: 'acquired',
    owner: Object.freeze({
      publish({ socketPort, httpPort, ...fields }: DaemonRegistrationFields) {
        acquisition.assertHeld();
        truncateDaemonLog(boundPaths.logPath);
        const transport = socketPort && httpPort ? 'dual' : httpPort ? 'http' : 'socket';
        acquisition.assertHeld();
        publishFileSync({
          destination: boundPaths.infoPath,
          contents: JSON.stringify(
            {
              ...fields,
              port: socketPort,
              httpPort,
              transport,
              pid: identity.pid,
              processStartTime: identity.startTime ?? undefined,
              stateDir: boundPaths.baseDir,
            },
            null,
            2,
          ),
          mode: 0o600,
        });
      },
      async finish(outcome?: DaemonShutdownOutcome) {
        let removal: DaemonRegistrationRemoval;
        try {
          if (outcome) writeShutdownReport(boundPaths.baseDir, outcome, acquisition);
          removal = removeRegistrationUnderLock(boundPaths.infoPath, identity, acquisition);
        } catch (error) {
          return await releaseRegistrationAfterFailure(acquisition, error, boundPaths.logPath);
        }
        await acquisition.release();
        return removal;
      },
    }),
  };
}

function removeRegistrationUnderLock(
  infoPath: string,
  identity: OwnerIdentity | null,
  acquisition: ProcessLockAcquisition,
): DaemonRegistrationRemoval {
  acquisition.assertHeld();
  const ownership = readRegisteredDaemonOwnership(infoPath, identity);
  if (ownership.state !== 'match') return ownership;
  acquisition.assertHeld();
  try {
    fs.unlinkSync(infoPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { state: 'removed' };
}

async function releaseRegistrationAfterFailure(
  acquisition: ProcessLockAcquisition,
  error: unknown,
  logPath: string,
): Promise<never> {
  try {
    await acquisition.release();
  } catch (releaseError) {
    await recordRegistrationWarning(logPath, 'daemon_registration_release_failed', releaseError);
  }
  throw error;
}

function writeShutdownReport(
  stateDir: string,
  outcome: DaemonShutdownOutcome,
  acquisition: ProcessLockAcquisition,
): void {
  const filePath = resolveDaemonShutdownReportPath(stateDir);
  const contents = `${JSON.stringify(buildDaemonShutdownReport(outcome))}\n`;
  acquisition.assertHeld();
  try {
    publishFileSync({ destination: filePath, contents, mode: 0o600 });
  } catch {
    return;
  }
}

/** The daemon's stdout and stderr append to this inode, so it is emptied in place, never replaced. */
function truncateDaemonLog(logPath: string): void {
  const descriptor = fs.openSync(logPath, 'a', 0o600);
  try {
    fs.ftruncateSync(descriptor, 0);
  } finally {
    fs.closeSync(descriptor);
  }
}

declare const privateReplayState: unique symbol;
export type OwnedReplayStateDir = Readonly<{
  paths: Readonly<DaemonPaths>;
  [privateReplayState]: true;
}>;
export type DaemonStartupLaunch = Readonly<{
  pid: number;
  startTime?: string;
  exited: Promise<ExecDetachedExit>;
  readIdentity(): OwnerIdentity;
}>;
type OwnedStartup = { launch: DaemonStartupLaunch; joined: boolean; startTime?: string };
type PrivateReplayState = {
  paths: Readonly<DaemonPaths>;
  startups: OwnedStartup[];
  sealed: boolean;
  retirement?: Promise<DaemonRetirementResult>;
};
const privateReplayStates = new WeakMap<OwnedReplayStateDir, PrivateReplayState>();

/** Creates deletion authority only for a fresh private replay directory. */
export function createOwnedReplayStateDir(): OwnedReplayStateDir {
  const paths = Object.freeze(
    resolveDaemonPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-daemon-'))),
  );
  const owned = Object.freeze({ paths }) as OwnedReplayStateDir;
  privateReplayStates.set(owned, { paths, startups: [], sealed: false });
  return owned;
}

/** Launches and monitors the actual child before recording its private-directory authority. */
export function launchDaemonProcess(
  input: Readonly<{
    paths: DaemonPaths;
    args: string[];
    serverMode: DaemonServerMode;
    ownedStateDir?: OwnedReplayStateDir;
  }>,
): DaemonStartupLaunch {
  const owned = input.ownedStateDir && requirePrivateReplayState(input.ownedStateDir, input.paths);
  if (owned?.sealed)
    throw new AppError('COMMAND_FAILED', 'Replay daemon startup admission is closed.', {
      reason: 'daemon_startup_admission_closed',
    });
  fs.mkdirSync(input.paths.baseDir, { recursive: true });
  const logFd = fs.openSync(input.paths.logPath, 'a');
  try {
    const monitored = runCmdDetachedMonitored(process.execPath, input.args, {
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: input.paths.baseDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: input.serverMode,
      },
      stdio: ['ignore', logFd, logFd],
    });
    const boundPaths = { ...input.paths };
    const startup: OwnedStartup = {
      launch: Object.freeze({
        ...monitored,
        get startTime() {
          return startup.startTime;
        },
        readIdentity() {
          recoverStartupBirth(boundPaths, startup);
          return { pid: monitored.pid, startTime: startup.startTime ?? null };
        },
      }),
      joined: false,
    };
    if (owned) owned.startups.push(startup);
    void monitored.exited.then(() => {
      startup.joined = true;
    });
    startup.startTime = readProcessStartTime(monitored.pid) ?? undefined;
    return startup.launch;
  } finally {
    fs.closeSync(logFd);
  }
}

function recoverStartupBirth(paths: DaemonPaths, startup: OwnedStartup): void {
  if (startup.startTime || startup.joined) return;
  const registration = readRegisteredDaemonIdentity(paths.infoPath);
  if (registration?.pid !== startup.launch.pid || !registration.startTime) return;
  const lock = inspectProcessLock(paths.lockPath);
  if (!processLockHoldsDaemonIdentity(lock, registration)) return;
  startup.startTime = registration.startTime;
}

function requirePrivateReplayState(
  capability: OwnedReplayStateDir,
  paths: DaemonPaths,
): PrivateReplayState {
  const owned = privateReplayStates.get(capability);
  if (
    !owned ||
    Object.entries(owned.paths).some(([key, value]) => paths[key as keyof DaemonPaths] !== value)
  ) {
    throw new AppError(
      'COMMAND_FAILED',
      'Private replay directory ownership could not be verified.',
      { reason: 'daemon_private_state_unowned' },
    );
  }
  return owned;
}

export type DaemonRetirementInput = Readonly<{
  paths: DaemonPaths;
  observed: OwnerIdentity | null;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  lockTimeoutMs?: number;
}>;

type RepairCommitFailure = NonNullable<ReturnType<typeof findUnrecoveredRepairCommitFailure>>;
type ConfirmedDaemonTermination = Extract<DaemonTerminationResult, { status: 'exited' }>;
export type DaemonRetirementResult =
  | Readonly<{
      status: 'retired';
      termination: ConfirmedDaemonTermination;
      removedInfo: boolean;
      removedStateDir?: boolean;
      repairCommitFailure?: RepairCommitFailure;
    }>
  | Readonly<{ status: 'absent'; removedInfo: false; removedStateDir?: boolean }>
  | Readonly<{
      status: 'retained';
      termination?: DaemonTerminationResult;
      removedInfo: boolean;
      removedStateDir?: boolean;
      reason:
        | 'ownership-unproven'
        | 'startup-unconfirmed'
        | 'exit-unconfirmed'
        | 'stop-failed'
        | 'lock-busy'
        | 'registration-replaced'
        | 'metadata-unreadable'
        | 'retirement-unconfirmed';
      error?: NormalizedError;
      repairCommitFailure?: RepairCommitFailure;
    }>;

/** Stops only the captured daemon lifetime, then retires its registration under the startup lock. */
export async function stopAndRetireDaemon(
  input: DaemonRetirementInput &
    Readonly<{
      mode: 'graceful' | 'force';
      ownedStateDir?: OwnedReplayStateDir;
      startupJoinTimeoutMs?: number;
    }>,
): Promise<DaemonRetirementResult> {
  let owned: PrivateReplayState | undefined;
  let observed = input.observed;
  try {
    if (input.ownedStateDir) {
      owned = requirePrivateReplayState(input.ownedStateDir, input.paths);
      owned.sealed = true;
      observed = confirmOwnedStartupIdentity(owned, observed);
      if (owned.retirement) return await owned.retirement;
    }
  } catch (error) {
    await joinOwnedStartups(owned, input.startupJoinTimeoutMs ?? 1_000);
    return {
      status: 'retained',
      reason: 'ownership-unproven',
      removedInfo: false,
      error: normalizeError(error),
    };
  }
  const retirement = retireObservedDaemon(
    { ...input, observed },
    (identity) =>
      stopDaemonProcess(identity, {
        mode: input.mode,
        termTimeoutMs: input.termTimeoutMs ?? 3_000,
        killTimeoutMs: input.killTimeoutMs ?? 1_000,
      }),
    owned,
    input.startupJoinTimeoutMs ?? 1_000,
  );
  if (owned) owned.retirement = retirement;
  const result = await retirement;
  if (owned && (result.status === 'absent' || !result.removedStateDir))
    owned.retirement = undefined;
  return result;
}

function confirmOwnedStartupIdentity(
  owned: PrivateReplayState,
  observed: OwnerIdentity | null,
): OwnerIdentity | null {
  if (!observed) {
    if (owned.startups.length === 0) return null;
    throw unownedStartupError();
  }
  const startup = owned.startups.find(({ launch }) => launch.pid === observed.pid);
  if (!startup) throw unownedStartupError();
  const { launch } = startup;
  const identity = observed.startTime ? observed : launch.readIdentity();
  if (launch.startTime && launch.startTime === identity.startTime) return identity;
  throw unownedStartupError();
}

function unownedStartupError(): AppError {
  return new AppError('COMMAND_FAILED', 'The observed daemon is not an owned startup lifetime.', {
    reason: 'daemon_private_startup_unowned',
  });
}

/** Recovers a confirmed abandoned registration without signaling a live process. */
export async function recoverAbandonedDaemonRegistration(
  input: DaemonRetirementInput,
): Promise<DaemonRetirementResult> {
  return await retireObservedDaemon(input, async (identity) => {
    if (!identity.startTime?.trim()) return { status: 'retained', reason: 'missing-start-time' };
    const confirmed = { pid: identity.pid, startTime: identity.startTime };
    return (await waitForDaemonExit(confirmed, { timeoutMs: 0 })).exited
      ? { status: 'exited', identity: confirmed, mode: 'already-exited' }
      : { status: 'retained', reason: 'identity-unverified' };
  });
}

async function retireObservedDaemon(
  input: DaemonRetirementInput,
  terminate: (identity: OwnerIdentity) => Promise<DaemonTerminationResult>,
  owned?: PrivateReplayState,
  startupJoinTimeoutMs = 1_000,
): Promise<DaemonRetirementResult> {
  const paths = { ...input.paths };
  const observed = input.observed && { ...input.observed };
  let termination: DaemonTerminationResult | undefined;
  let stopFailure: NormalizedError | undefined;
  if (observed) {
    try {
      termination = await terminate(observed);
    } catch (error) {
      stopFailure = normalizeError(error);
    }
  }
  const joined = await joinOwnedStartups(owned, startupJoinTimeoutMs);
  if (stopFailure)
    return { status: 'retained', reason: 'stop-failed', removedInfo: false, error: stopFailure };
  if (termination && termination.status !== 'exited')
    return { status: 'retained', reason: 'exit-unconfirmed', termination, removedInfo: false };
  if (!joined) {
    return { status: 'retained', reason: 'startup-unconfirmed', termination, removedInfo: false };
  }
  return await retireDaemonRegistration({ ...input, paths }, termination, owned);
}

async function retireDaemonRegistration(
  input: DaemonRetirementInput,
  termination: ConfirmedDaemonTermination | undefined,
  owned?: PrivateReplayState,
): Promise<DaemonRetirementResult> {
  const paths = input.paths;
  let acquisition: ProcessLockAcquisition;
  try {
    acquisition = await acquireProcessLockAcquisition({
      lockDirPath: paths.lockPath,
      owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
      description: 'daemon registration retirement',
      timeoutMs: input.lockTimeoutMs ?? 1_000,
    });
  } catch (error) {
    const failure = normalizeError(error);
    return {
      status: 'retained',
      reason:
        failure.details?.reason === 'process_lock_timeout' ? 'lock-busy' : 'retirement-unconfirmed',
      termination,
      removedInfo: false,
      error: failure,
    };
  }
  let result: DaemonRetirementResult = {
    status: 'retained',
    reason: 'retirement-unconfirmed',
    removedInfo: false,
  };
  try {
    const removal = removeRegistrationUnderLock(
      paths.infoPath,
      termination?.identity ?? null,
      acquisition,
    );
    result = retirementAfterRemoval(removal, termination);
    result = retirePrivateStateIfEligible(owned, acquisition, result);
  } catch (error) {
    result = {
      status: 'retained',
      reason: 'retirement-unconfirmed',
      termination,
      removedInfo: result.removedInfo,
      error: normalizeError(error),
    };
  }
  return await releaseAfterRetirement(acquisition, result, paths.logPath);
}

async function releaseAfterRetirement(
  acquisition: ProcessLockAcquisition,
  result: DaemonRetirementResult,
  logPath: string,
): Promise<DaemonRetirementResult> {
  try {
    await acquisition.release();
  } catch (error) {
    const primary = result.status === 'retained' ? result.error : undefined;
    if (primary)
      await recordRegistrationWarning(logPath, 'daemon_retirement_release_failed', error);
    result = {
      ...result,
      status: 'retained',
      reason: 'retirement-unconfirmed',
      error: primary ?? normalizeError(error),
    };
  }
  return result;
}

function retirementAfterRemoval(
  removal: DaemonRegistrationRemoval,
  termination: ConfirmedDaemonTermination | undefined,
): DaemonRetirementResult {
  if (termination && (removal.state === 'removed' || removal.state === 'absent')) {
    return { status: 'retired', termination, removedInfo: removal.state === 'removed' };
  }
  if (removal.state === 'absent') return { status: 'absent', removedInfo: false };
  return {
    status: 'retained',
    termination,
    removedInfo: false,
    reason:
      removal.state === 'replaced'
        ? 'registration-replaced'
        : removal.state === 'unreadable'
          ? 'metadata-unreadable'
          : 'ownership-unproven',
  };
}

async function recordRegistrationWarning(
  logPath: string,
  phase: string,
  error: unknown,
): Promise<void> {
  await withDaemonDiagnosticsScope({ logPath }, () => {
    emitDiagnostic({ level: 'warn', phase, data: { error: normalizeError(error) } });
  });
}

async function joinOwnedStartups(
  owned: PrivateReplayState | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!owned || owned.startups.every((startup) => startup.joined)) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all(owned.startups.map(({ launch }) => launch.exited)).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function retirePrivateStateIfEligible(
  owned: PrivateReplayState | undefined,
  acquisition: ProcessLockAcquisition,
  result: DaemonRetirementResult,
): DaemonRetirementResult {
  if (
    !owned ||
    (result.status !== 'retired' && !(result.status === 'absent' && owned.startups.length === 0))
  )
    return result;
  try {
    acquisition.assertHeld();
    const failure = findUnrecoveredRepairCommitFailure(owned.paths.sessionsDir);
    if (failure)
      return result.status === 'retired'
        ? { ...result, removedStateDir: false, repairCommitFailure: failure }
        : {
            status: 'retained',
            reason: 'retirement-unconfirmed',
            removedInfo: false,
            removedStateDir: false,
            repairCommitFailure: failure,
          };
    acquisition.assertHeld();
    fs.rmSync(owned.paths.baseDir, { recursive: true, force: true });
    return { ...result, removedStateDir: true };
  } catch (error) {
    return {
      ...result,
      status: 'retained',
      reason: 'retirement-unconfirmed',
      removedStateDir: false,
      error: normalizeError(error),
    };
  }
}
