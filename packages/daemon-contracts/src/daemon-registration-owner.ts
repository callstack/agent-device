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
  appendPrivateStateFileSync,
  ensurePrivateDirectoryChain,
  privateDirectoryWordingOf,
  publishFileSync,
  publishPrivateStateFileSync,
  tryOpenPrivateStateFileSync,
  writePrivateStateLineSync,
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
import {
  sweepDeadDaemonStartupPhasesFiles,
  type DaemonStartupPhase,
} from './daemon-startup-phases.ts';

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
  // Both cleanups are tidying, and neither is this startup's outcome: a shutdown report or a phase marker the
  // daemon cannot remove is one more stale record in a directory this run already judged. Removing them by
  // NAME is also what would follow a planted link, so `rmSync` failing is a host fact to write down, not a
  // reason to hand the registration back and fail a daemon that holds a lock nobody else can take.
  clearStaleDaemonRecords(acquisition, boundPaths);
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
      // The report is a state diagnostic: judged chain, a sibling this call creates exclusively at 0600,
      // and a rename over whatever name stands there (#4649). A chain that fails the rule costs the
      // report, never the shutdown.
      publishPrivateStateFileSync(
        resolveDaemonShutdownReportPath(boundPaths.baseDir),
        `${JSON.stringify(buildDaemonShutdownReport(outcome, identity))}\n`,
      );
    } catch (error) {
      reportStateRecordFailure(boundPaths.logPath, 'daemon_shutdown_record_failed', error);
    }
  }
}

/**
 * Writes down a state record this process refused or failed to write.
 *
 * Never by going back to the refused path's NAME. The verified handle is tried first, and a chain that
 * refuses the record refuses that handle too — a FIFO planted at `daemon.log` would block this append and a
 * link would redirect the very warning about being planted. Then the line goes to this process's stderr,
 * which the launcher already holds open on the log: an already-trusted descriptor that no name in the
 * refused directory can steer.
 */
function reportStateRecordFailure(logPath: string, phase: string, error: unknown): void {
  const opened = tryOpenPrivateStateFileSync(logPath, 'append');
  if (opened.descriptor !== undefined) {
    try {
      writePrivateStateLineSync(
        opened.descriptor,
        `${JSON.stringify({ level: 'warn', phase, error: normalizeError(error) })}\n`,
      );
      return;
    } catch {
      // The handle was refused after all; stderr is where this goes.
    } finally {
      try {
        fs.closeSync(opened.descriptor);
      } catch {
        // Nothing is left to do with a descriptor the host will not close.
      }
    }
  }
  reportRefusedStateSink(logPath, error, phase);
}

/**
 * Says out loud that a state sink was refused, on this process's own stderr, and survives a host that will
 * not take the write.
 *
 * For a detached daemon this stream is the log already: the launcher holds this process's stdout and stderr
 * open on the verified log descriptor. For an embedded runtime it is the host's own stream. Either way it is a
 * descriptor no entry inside a refused directory can steer, which is why refusals go here and never back to the
 * refused name. A redirected stderr whose pipe is closed throws out of `write`, and a refusal is not worth
 * losing a shutdown or a registration release over, so the write itself is the one thing here that is best
 * effort.
 */
function reportRefusedStateSink(refusedPath: string, error: unknown, phase = 'refused'): void {
  try {
    process.stderr.write(`Daemon ${phase}: ${refusedPath}: ${normalizeError(error).message}\n`);
  } catch {
    // No sink is left. The refusal still stands as the answer the caller got.
  }
}

/**
 * This host's null device, for a launch whose log the state rule refused.
 *
 * The child still starts: an untrusted log name is a reason not to write the log, not a reason not to run a
 * daemon. Its output goes where a write goes and cannot block, and the refusal is on stderr.
 */
function openNullDeviceSync(): number {
  return fs.openSync(os.devNull, 'w');
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

/**
 * The state chains this process has established, so the create-and-repair walk is asked ONCE per directory.
 *
 * Establishment is the ACTION half of the rule: it makes missing levels at 0700 and narrows a loose level this
 * user owns, and says what it found. Nothing about a later write trusts its answer — every state open judges
 * the chain again and proves the descriptor it got (#4649) — so asking the action a dozen times in one startup,
 * once per phase marker, buys no safety and re-opens ground the first ask already settled.
 */
const establishedStateDirs = new Set<string>();

/**
 * Establishes the daemon's state chain and says out loud what it found, in the one order both callers use.
 *
 * The line goes to this process's stderr, which the launcher redirects into the daemon log. Nothing here
 * refuses a startup: an exposed state directory is a fact about the host, and the per-file rule is what
 * withholds a record from it (#4649).
 */
export function establishPrivateDaemonStateDir(stateDir: string): void {
  // `path.join(..., '.')` normalizes the spelling without resolving links, so two callers that name one
  // directory differently ask once, and a `..` cannot smuggle a second walk of the same route.
  const asked = path.join(stateDir, '.');
  if (establishedStateDirs.has(asked)) return;
  establishedStateDirs.add(asked);
  const chain = ensurePrivateDirectoryChain(stateDir);
  if (chain.exposure) {
    process.stderr.write(
      `Daemon state dir ${chain.directory} is not private: ${privateDirectoryWordingOf(chain.exposure)}\n`,
    );
  }
}

/**
 * Appends one startup phase marker, or reports the refusal and carries on.
 *
 * This is the DAEMON side of the marker: whoever writes one comes through here, because a marker is a state
 * diagnostic and a state diagnostic goes only into a chain this process owns (#4649). The caller establishes
 * the chain at its own entry point, once, and this function asks the chain for ITSELF on every write: the
 * judgment that decides is the one made as the bytes go out, and it is never inherited from an earlier repair.
 * A refusal is a typed `state_dir_untrusted` failure sent to `reportFailure`: never fatal, and never a silent
 * success.
 */
export function recordDaemonStartupMarker(
  startupPhasesPath: string,
  phase: DaemonStartupPhase,
  reportFailure?: (error: NormalizedError) => void,
): void {
  try {
    establishPrivateDaemonStateDir(path.dirname(startupPhasesPath));
    appendPrivateStateFileSync(
      startupPhasesPath,
      `${JSON.stringify({ data: { startupPhase: phase, timestampMs: Date.now() } })}\n`,
    );
  } catch (error) {
    reportFailure?.(normalizeError(error));
  }
}

/**
 * Removes the records a previous run left behind, and never makes this startup fail over one.
 *
 * A stale shutdown report is one this daemon's next stop will overwrite anyway, and a dead owner's phase
 * marker is one the sweep exists to tidy; neither is an outcome of acquiring the registration. Both are removed
 * by name, so a refusal is a host fact about ground this run does not control, and the place it is written down
 * is the state record's own failure sink — never the refused name's.
 */
function clearStaleDaemonRecords(
  acquisition: ProcessLockAcquisition,
  paths: Readonly<DaemonPaths>,
): void {
  try {
    acquisition.assertHeld();
    fs.rmSync(resolveDaemonShutdownReportPath(paths.baseDir), { force: true });
  } catch (error) {
    reportStateRecordFailure(paths.logPath, 'daemon_stale_report_cleanup_failed', error);
  }
  try {
    sweepDeadDaemonStartupPhasesFiles(paths.baseDir);
  } catch (error) {
    reportStateRecordFailure(paths.logPath, 'daemon_stale_marker_sweep_failed', error);
  }
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
 * The daemon's stdout and stderr append to this inode, so it is emptied in place, never replaced.
 *
 * The truncate happens THROUGH a verified handle: `O_TRUNC` said at a NAME would empty whatever that name
 * describes — the file a planted link points at, or the FIFO another local user left — before any rule got a
 * look at it. So the log is opened the way every state record is, judged chain and link-free, and emptied with
 * `ftruncate` on the descriptor the judgment produced, which is also what pins the inode for the whole
 * operation (#3291).
 *
 * A refusal is reported and skipped, never answered by opening the name again: the thing that made the verified
 * open refuse is exactly what a plain `fs.openSync(logPath, 'a')` would follow. An unemptied log costs this run
 * the previous run's lines. Failing a startup over a stale log would cost it the daemon.
 */
function truncateDaemonLog(logPath: string): void {
  const opened = tryOpenPrivateStateFileSync(logPath, 'truncate');
  if (opened.descriptor === undefined) {
    reportRefusedStateSink(logPath, opened.failure, 'daemon_log_truncate');
    return;
  }
  try {
    fs.closeSync(opened.descriptor);
  } catch {
    // The truncation already happened at the moment the verified open returned.
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
  // One call owns the boundary: 0700 creation whatever the umask, and the narrowest best-effort repair
  // of a level this user already owns, said on the judged inode. The answer is a fact about the host, never
  // a reason to refuse a startup, so a chain the daemon does not own is written down and left as it is.
  establishPrivateDaemonStateDir(input.paths.baseDir);
  // The log the child's stdout and stderr become is opened the way every state file is: judged chain,
  // link-free open, mode said on the descriptor. A chain that refuses that open gets NO reopening of the
  // name: the refusal is about what stands at that name — a link, a FIFO, ground another local user
  // controls — and a plain append by name would follow it, or block on it, which is the outcome the
  // verified open exists to avoid. The child then writes to this host's null device, and the refusal is said
  // on this process's stderr, which is the one sink no entry in that directory can steer.
  const opened = tryOpenPrivateStateFileSync(input.paths.logPath, 'append');
  if (opened.failure !== undefined) {
    reportRefusedStateSink(input.paths.logPath, opened.failure, 'daemon_log_open_refused');
  }
  const logFd = opened.descriptor ?? openNullDeviceSync();
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
