import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCmdDetachedMonitored, type ExecDetachedExit } from '@agent-device/host-kit/command';
import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
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
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import { withDaemonDiagnosticsScope } from './daemon-diagnostics-scope.ts';
import type { DaemonCodeOrigin } from '@agent-device/host-kit/code-signature';
import {
  resolveDaemonPaths,
  type DaemonCapability,
  type DaemonRuntimeOwnership,
  type DaemonPaths,
  type DaemonServerMode,
  type ObservedDaemonIdentity,
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
import { sweepDeadDaemonStartupPhasesFiles } from './daemon-startup-phases.ts';

export const DAEMON_STARTUP_EXIT_CODES = Object.freeze({ busy: 75, unproven: 78 });
export type DaemonRegistrationFields = Readonly<{
  socketPort?: number;
  httpPort?: number;
  token: string;
  version: string;
  codeOrigin: DaemonCodeOrigin;
  codeSignature?: string;
  policyDigest?: string;
  /** What this daemon can do beyond the base RPC contract; absent from daemons that predate it. */
  capabilities?: readonly DaemonCapability[];
  /** The provider plugin inventory, so a client can read what this daemon registered. */
  plugins?: readonly PluginInventoryEntry[];
  /** Who owns this process; see {@link DaemonRuntimeOwnership}. Absent records are detached daemons. */
  ownership?: DaemonRuntimeOwnership;
}>;
type DaemonRegistrationRemoval =
  | Readonly<{ state: 'removed' }>
  | Exclude<RegisteredDaemonOwnership, { state: 'match' }>;
export type DaemonRegistrationOwner = Readonly<{
  publish(fields: DaemonRegistrationFields): void;
  finish(
    outcome?: DaemonShutdownOutcome,
    close?: Readonly<{ retainRegistration: boolean }>,
  ): Promise<DaemonRegistrationRemoval | Readonly<{ state: 'retained' }>>;
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
    sweepDeadDaemonStartupPhasesFiles(boundPaths.baseDir);
  } catch (error) {
    await releaseRegistrationAfterFailure(acquisition, error, boundPaths.logPath);
  }
  let published: Pick<DaemonRegistrationFields, 'ownership'> | undefined;
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
        published = { ownership: fields.ownership };
      },
      async finish(
        outcome?: DaemonShutdownOutcome,
        close?: Readonly<{ retainRegistration: boolean }>,
      ) {
        let removal: DaemonRegistrationRemoval | Readonly<{ state: 'retained' }>;
        try {
          acquisition.assertHeld();
          removal = close?.retainRegistration
            ? { state: 'retained' }
            : removeRegistrationUnderLock(boundPaths.infoPath, identity, acquisition);
        } catch (error) {
          await writeShutdownReport(outcome);
          if (published?.ownership === 'embedded') throw error;
          return await releaseRegistrationAfterFailure(acquisition, error, boundPaths.logPath);
        }
        const released = removal.state === 'removed' || removal.state === 'absent';
        await writeShutdownReport(outcome);
        if (removal.state !== 'retained' && (released || published?.ownership !== 'embedded')) {
          await acquisition.release();
        }
        return removal;
      },
    }),
  };

  async function writeShutdownReport(outcome: DaemonShutdownOutcome | undefined): Promise<void> {
    if (!outcome) return;
    try {
      acquisition.assertHeld();
      publishFileSync({
        destination: resolveDaemonShutdownReportPath(boundPaths.baseDir),
        contents: `${JSON.stringify(buildDaemonShutdownReport(outcome))}\n`,
        mode: 0o600,
      });
    } catch (error) {
      await recordRegistrationWarning(
        boundPaths.logPath,
        'daemon_shutdown_record_failed',
        error,
      ).catch(() => {});
    }
  }
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
    await recordRegistrationWarning(
      logPath,
      'daemon_registration_release_failed',
      releaseError,
    ).catch(() => {});
  }
  throw error;
}

/**
 * The daemon's stdout and stderr append to this inode, so it is emptied in place, never
 * replaced. On POSIX the append handle that creates the file also permits truncation, and
 * keeping that one handle open for the whole operation is what pins the inode. A Windows
 * handle opened append-only (`'a'`) rejects `ftruncate` with EPERM, so that host empties the
 * log through a read-write handle instead (#3291). A failure at any step propagates: an
 * unreadable log must fail startup loudly.
 */
function truncateDaemonLog(logPath: string): void {
  if (process.platform === 'win32') {
    truncateDaemonLogOnWindowsHost(logPath);
    return;
  }
  const descriptor = fs.openSync(logPath, 'a', 0o600);
  try {
    fs.ftruncateSync(descriptor, 0);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * `ftruncate` on Windows requires a handle opened for writing beyond append. An existing log
 * is opened `'r+'` directly, so no window exists between handles on the common path; a
 * missing log is first created through `'a'` and then reopened, and a creation race against
 * that reopen surfaces as this startup failing rather than a silently unemptied log.
 */
function truncateDaemonLogOnWindowsHost(logPath: string): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(logPath, 'r+', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.closeSync(fs.openSync(logPath, 'a', 0o600));
    descriptor = fs.openSync(logPath, 'r+', 0o600);
  }
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
    /** The environment the daemon process starts with, before the state dir and mode overrides. */
    env: EnvMap;
    /** The daemon's working directory: the one its client resolves relative paths against. */
    cwd: string;
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
      cwd: input.cwd,
      env: {
        ...input.env,
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
  /**
   * The lifetime a caller proved the daemon is, with the owner that record stated at the read. A caller
   * that launched the process itself states `detached`, which is what it knows; a caller that read
   * `daemon.json` passes what that record stated. Signalling on a guessed owner is the one thing this
   * module must not do, so no caller may leave this out.
   */
  observed: ObservedDaemonIdentity | null;
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
        /** A host owns the observed runtime; only that host closes it. */
        | 'embedded-owner'
        /**
         * The record states an owner this build cannot read, so nothing proves the pid it names is a
         * daemon of its own, and signalling it is refused.
         */
        | 'owner-unproven'
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
  // Signalling needs a proven owner, and the observation carries the one its record stated: a record
  // naming a host describes a runtime that host ends, and a record stating an owner this build cannot
  // read says nothing about what is safe to end. Only a proven detached daemon is signaled.
  const owner = observed?.ownership;
  const retirement = retireObservedDaemon(
    { ...input, observed },
    observed && owner !== 'detached'
      ? (identity) =>
          proveExitWithoutSignaling(
            identity,
            owner === 'embedded' ? 'embedded-owner' : 'owner-unproven',
          )
      : (identity) =>
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
  observed: ObservedDaemonIdentity | null,
): ObservedDaemonIdentity | null {
  if (!observed) {
    if (owned.startups.length === 0) return null;
    throw unownedStartupError();
  }
  const startup = owned.startups.find(({ launch }) => launch.pid === observed.pid);
  if (!startup) throw unownedStartupError();
  const { launch } = startup;
  const identity = observed.startTime ? observed : { ...observed, ...launch.readIdentity() };
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
  return await retireObservedDaemon(input, (identity) => proveExitWithoutSignaling(identity));
}

/**
 * Termination refusals that name an owner's rule rather than a lifetime this caller could not prove:
 * both mean "nobody may signal this process", and both travel to the caller at the top level.
 */
function isOwnerRefusal(
  reason: Extract<DaemonTerminationResult, { status: 'retained' }>['reason'],
): reason is 'embedded-owner' | 'owner-unproven' {
  return reason === 'embedded-owner' || reason === 'owner-unproven';
}

/**
 * Proves `observed` is gone and signals nothing, which is what a lifecycle path may do to a process
 * it does not own: an abandoned registration, or one a host owns and ends itself. A lifetime whose
 * exit cannot be proved stays exactly where it is.
 */
async function proveExitWithoutSignaling(
  observed: OwnerIdentity,
  reason: 'identity-unverified' | 'embedded-owner' | 'owner-unproven' = 'identity-unverified',
): Promise<DaemonTerminationResult> {
  if (!observed.startTime?.trim())
    return {
      status: 'retained',
      reason: reason === 'identity-unverified' ? 'missing-start-time' : reason,
    };
  const identity = { pid: observed.pid, startTime: observed.startTime };
  return (await waitForDaemonExit(identity, { timeoutMs: 0 })).exited
    ? { status: 'exited', identity, mode: 'already-exited' }
    : { status: 'retained', reason };
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
  // A terminate step that refused because the record's owner ends this runtime, or because the record
  // could not prove one, says so at the top: a caller must be able to tell "nobody may signal this
  // process" from "this daemon is hung".
  if (termination?.status === 'retained' && isOwnerRefusal(termination.reason)) {
    return { status: 'retained', reason: termination.reason, termination, removedInfo: false };
  }
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
