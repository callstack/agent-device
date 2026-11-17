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
  acquireProcessLockAcquisition,
  childName,
  childPath,
  createStateLevels,
  inspectProcessLock,
  parentDirectoryPath,
  publishFileSync,
  scriptAncestryReason,
  tryAcquireProcessLock,
  verifiedDirectoryGround,
  verifiedDirectoryPath,
  withoutTrailingSeparators,
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
  ensureDaemonStateDir(input.paths.baseDir, input.paths.baseDir);
  const logFd = fs.openSync(input.paths.logPath, 'a', 0o600);
  try {
    repairStateMode(input.paths.logPath, 0o600);
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

/**
 * Creates one of the daemon's own state directories at 0700 and answers whether every level of that chain is
 * private ground. A refusal is the ANCESTRY, never a MODE (#4565); ADR 0016 owns the rule that reads it.
 */
export function ensurePrivateDaemonStateDir(directory: string, stateBase: string): DaemonStateDir {
  return repairStateChain(stateBase, directory, 'script');
}

/** The directory to write under, and whether every level is this uid's at 0700, reached by no link. */
export type DaemonStateDir = Readonly<{ path: string; privateChain: boolean }>;

/**
 * For a caller that writes no script under the directory — startup, a session's artifacts, a tombstone: the
 * path, verdict unread. Untrusted ground refuses the script writer, never this caller.
 */
export function ensureDaemonStateDir(directory: string, stateBase: string): string {
  return repairStateChain(stateBase, directory, 'own-state').path;
}

/** The only creation ground the walk refused sees: `main`'s recursive `mkdir`, and NO mode change. */
function createOwnStateLevels(directory: string): void {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: STATE_DIR_MODE });
  } catch (error) {
    skipStateDirMode(directory, stateRepairReason(error));
  }
}

type StateDirUse = 'script' | 'own-state';

const STATE_DIR_MODE = 0o700;
const STATE_DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

/**
 * Forces every state level from `stateBase` down to `directory` to {@link STATE_DIR_MODE}, and never throws.
 * The base is resolved ONCE by {@link verifiedDirectoryPath}; only NAMES below it are built (ADR 0016).
 */
function repairStateChain(stateBase: string, directory: string, use: StateDirUse): DaemonStateDir {
  // Windows answers access from an ACL and `chmod` only toggles the read-only bit: nothing to judge.
  if (process.platform === 'win32') {
    createOwnStateLevels(directory);
    return { path: directory, privateChain: true };
  }
  let physical: string;
  try {
    const base = standOnStateBase(stateBase);
    // No script goes on ground nothing judged; `own-state` still gets its own levels (#4584).
    if (base === undefined) {
      if (use === 'own-state') createOwnStateLevels(directory);
      return { path: directory, privateChain: false };
    }
    physical = base;
  } catch (error) {
    // Nothing is known of this chain, so nothing else is touched; one skip says so.
    skipStateDirMode(stateBase, stateRepairReason(error));
    return { path: directory, privateChain: false };
  }
  const tail = stateTailBelow(stateBase, directory);
  if (tail === undefined) {
    skipStateDirMode(directory, 'not_below_state_base');
    return { path: directory, privateChain: false };
  }
  // Every level is a NAME under the verified base: the descent is the chain the walk judged.
  const verified = tail.reduce((level, name) => childPath(level, name), physical);
  return {
    path: verified,
    privateChain: descendStateChain(stateBase, directory, physical, tail, use),
  };
}

/**
 * Stands on the state base and answers its name as the walk spells it — UNNORMALIZED, so a link AT the base
 * is `lstat`ed as a level, not followed — or `undefined` after saying why.
 */
function standOnStateBase(stateBase: string): string | undefined {
  const answered = verifiedDirectoryPath(stateBase);
  if ('physical' in answered) {
    const base = answered.physical;
    if (fs.lstatSync(base, { bigint: true, throwIfNoEntry: false }) !== undefined) return base;
    const parent = parentDirectoryPath(base);
    if (parent === undefined) {
      skipStateDirMode(base, 'state_base_unreachable');
      return undefined;
    }
    createStateLevels(base, parent, [childName(base)]);
    if (fs.lstatSync(base, { bigint: true, throwIfNoEntry: false }) === undefined) {
      skipStateDirMode(base, 'absent');
      return undefined;
    }
    return base;
  }
  // The one refusal that is a fresh host rather than an exposure: a name above the base is absent.
  if (answered.exposure !== 'unreachable_parent') {
    skipStateDirMode(answered.ancestor, `state_ancestry_${answered.exposure}`);
    return undefined;
  }
  const ground = verifiedDirectoryGround(stateBase);
  if (ground.ended !== 'short' || ground.unresolvable) {
    skipStateDirMode(stateBase, `state_ancestry_${answered.exposure}`);
    return undefined;
  }
  createStateLevels(stateBase, ground.established, ground.missing);
  // Asked again now the names stand: the answer is the base's own name on judged ground.
  const reached = verifiedDirectoryPath(stateBase);
  if (!('physical' in reached)) {
    skipStateDirMode(reached.ancestor, `state_ancestry_${reached.exposure}`);
    return undefined;
  }
  return reached.physical;
}

/**
 * Walks the base and the names below it, one at a time, forcing each to the private mode, and reports whether
 * every one is private ground. The ORDER is the blocker fix: a level is judged BEFORE anything is created below
 * it, so a link at `sessions` stops the descent and no SCRIPT destination is made under it.
 */
function descendStateChain(
  base: string,
  directory: string,
  physicalBase: string,
  tail: readonly string[],
  use: StateDirUse,
): boolean {
  let physical = physicalBase;
  let spelled = base;
  let privateChain = true;
  for (let index = -1; index < tail.length; index += 1) {
    const parent = physical;
    if (index >= 0) {
      const name = tail[index]!;
      spelled = childPath(spelled, name);
      physical = childPath(physical, name);
    }
    const verdict = judgeStateLevel(spelled, physical, parent, tail, index);
    if (verdict === 'stop') {
      // ANY level this walk stops on ends the chain for a script destination, whoever owns it. The caller that
      // writes no script there is still given main's one recursive `mkdir` of the requested directory, however
      // far below the stopped level it sits: that is what it ran before this rule existed.
      if (use === 'own-state') createOwnStateLevels(directory);
      return false;
    }
    if (verdict !== 'private') privateChain = false;
  }
  return privateChain;
}

/** Whether the descent may pass one level, and what that level is. */
type StateLevelVerdict = 'private' | 'loose' | 'stop';

/** Stands on one level and answers whether the descent may pass it; an ABSENT name is made first. */
function judgeStateLevel(
  spelled: string,
  physical: string,
  parent: string,
  tail: readonly string[],
  index: number,
): StateLevelVerdict {
  let standing;
  try {
    standing = repairStateLevel(physical);
    if (standing.ended === 'absent' && index >= 0) {
      createStateLevels(spelled, parent, tail.slice(index));
      standing = repairStateLevel(physical);
      // Still absent after creating: that is no level to stand on, and not a fresh host to create for.
      if (standing.ended === 'absent') return 'stop';
    }
  } catch (error) {
    // A plain FILE where a level must be: the caller gets `mkdir`'s own `ENOTDIR`.
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') throw error;
    skipStateDirMode(physical, stateRepairReason(error));
    return 'stop';
  }
  if (standing.ended === 'absent') {
    skipStateDirMode(physical, 'absent');
    return 'stop';
  }
  if (standing.ended === 'stopped') return 'stop';
  return standing.ended === 'private' ? 'private' : 'loose';
}

type StateLevelStanding = Readonly<{ ended: 'absent' | 'stopped' | 'private' }>;

/** Why the chain stopped: the host's `errno` code, or host-kit's ancestry reason for the same rule. */
function stateRepairReason(error: unknown): string {
  return (
    scriptAncestryReason(error) ?? (error as NodeJS.ErrnoException).code ?? 'state_chain_unjudged'
  );
}

/**
 * The NAMES from `stateBase` down to `directory`, base excluded, or `undefined` when it is not below it:
 * names, never a path, so no `..` or alias moves a level onto unjudged ground.
 */
function stateTailBelow(stateBase: string, directory: string): readonly string[] | undefined {
  const below = path.relative(
    withoutTrailingSeparators(stateBase),
    withoutTrailingSeparators(directory),
  );
  if (below === '' || below === '.') return [];
  if (below === '..' || below.startsWith(`..${path.sep}`) || path.isAbsolute(below))
    return undefined;
  return below.split(path.sep);
}

/**
 * Forces one level, judged by `lstat` first: a link, a non-directory or a foreign owner stops the
 * descent. The mode goes by descriptor, since `chmod` by NAME acts on what the name resolves to.
 */
function repairStateLevel(level: string): StateLevelStanding {
  const judged = fs.lstatSync(level, { bigint: true, throwIfNoEntry: false });
  if (judged === undefined) return { ended: 'absent' };
  // Asked BEFORE the mode: a LINK at 0700 answers the mode question privately.
  if (judged.isSymbolicLink()) {
    skipStateDirMode(level, 'link_at_state_level');
    return { ended: 'stopped' };
  }
  // A plain FILE at a level: `mkdir`'s own `ENOTDIR`, since every write under that name fails anyway.
  if (!judged.isDirectory())
    throw Object.assign(new Error(`ENOTDIR: not a directory, mkdir '${level}'`), {
      code: 'ENOTDIR',
      path: level,
    });
  if (Number(judged.uid) !== (process.getuid?.() ?? -1)) {
    skipStateDirMode(level, 'foreign_owned');
    return { ended: 'stopped' };
  }
  // A level already at the mode needs nothing: the common start pays no open.
  if ((Number(judged.mode) & 0o777) === STATE_DIR_MODE) return { ended: 'private' };
  return { ended: forcePrivateStateDir(level) ? 'private' : 'stopped' };
}

/** Forces one level through a link-proof descriptor: only it says what the `fchmod` actually changed. */
function forcePrivateStateDir(level: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(level, STATE_DIR_FLAGS);
    if (Number(fs.fstatSync(descriptor, { bigint: true }).uid) !== (process.getuid?.() ?? -1)) {
      skipStateDirMode(level, 'foreign_owned');
      return false;
    }
    fs.fchmodSync(descriptor, STATE_DIR_MODE);
    return true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Says where the repair stopped: a skip is never a refusal. */
function skipStateDirMode(level: string, reason: string): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'daemon_state_mode_repair_skipped',
    data: { path: level, reason: `state mode repair stopped at this level: ${reason}` },
  });
}

/** Host limits a `chmod` cannot beat: none is ground to judge or a reason to stop a daemon. */
const MODE_REPAIR_SKIPPED_CODES = new Set(['EPERM', 'EROFS', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * Forces a pre-existing state PATH — file as much as directory — to `mode`, and never decides whether the
 * daemon starts: what another user owns, or a mount with no chmod, keeps what it has.
 */
function repairStateMode(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    if (!MODE_REPAIR_SKIPPED_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    emitDiagnostic({
      level: 'warn',
      phase: 'daemon_state_mode_repair_skipped',
      data: { path: target, error: normalizeError(error) },
    });
  }
}
