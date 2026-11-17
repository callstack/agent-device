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
  verifiedDirectoryPath,
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

/**
 * Creates one of the daemon's own state directories, and forces the mode of one that exists, to 0700.
 *
 * Every directory on the chain of a script destination the daemon picks for itself — the state dir,
 * `sessions/`, `remote-scripts/` — is judged by the destination-ancestry rule on the way to a recording
 * (ADR 0016), and that rule refuses a group-writable directory. A mode-less `mkdir` under the shared-checkout
 * umask 002 creates `sessions/` at 0775, so creation carries the mode and the repair forces it for a level
 * an older version already left loose.
 *
 * The repair is BEST-EFFORT and never refuses (#4565): a state directory on a mounted volume, or one another
 * uid left at 0755, still gets a daemon that starts. It answers {@link DaemonStateDir}, and a caller that
 * WRITES under the directory reads the verdict on the chain; startup ignores it.
 *
 * `stateBase` is the daemon's state directory that the levels below it are judged from: a level is repaired
 * only when every level above it, down from that base, is one this process may judge. {@link
 * repairStateChain} says why the whole chain has to be judged rather than the leaf alone.
 */
export function ensurePrivateDaemonStateDir(directory: string, stateBase: string): DaemonStateDir {
  // One recursive `mkdir`, BEFORE the chain is judged: it creates the whole tail even on ground the repair
  // will stop at, which is what keeps a `~/.agent-device` linked to another disk working. What it can leave
  // beyond a rejected level is an empty directory, and no script is published on a chain the verdict refuses.
  fs.mkdirSync(directory, { recursive: true, mode: STATE_DIR_MODE });
  const chain = repairStateChain(stateBase, directory);
  return { path: chain.directory, privateChain: chain.privateChain };
}

/**
 * What {@link ensurePrivateDaemonStateDir} leaves behind: the directory it created or repaired, and whether
 * every level from the state base down to it is now a real directory this uid owns, standing 0700, reached
 * without following a link. `privateChain: false` says the repair STOPPED somewhere on that chain. It does
 * not say anything failed — startup proceeds either way — only that a script must not be written there.
 *
 * `path` is the VERIFIED spelling: the physical state base with this directory's own names re-attached, so a
 * caller that writes under it builds its file names off the chain the repair judged rather than off a
 * configuration string. It names the same entry the caller passed, and one more level under it is the shape
 * {@link ensureDaemonStateDir} takes.
 */
export type DaemonStateDir = Readonly<{ path: string; privateChain: boolean }>;

/**
 * {@link ensurePrivateDaemonStateDir} for a caller that writes no script under the directory — startup, or a
 * tombstone written beside a session — so it takes the path and leaves the verdict unread.
 */
export function ensureDaemonStateDir(directory: string, stateBase: string): string {
  return ensurePrivateDaemonStateDir(directory, stateBase).path;
}

const STATE_DIR_MODE = 0o700;

/**
 * Forces every state level from `stateBase` down to `directory` to {@link STATE_DIR_MODE}, and never throws.
 *
 * The base is resolved ONCE, first, by {@link verifiedDirectoryPath} — the walk a script destination is
 * judged by, not a second rule — and the physical directory it arrives on is the ONLY name anything below is
 * built from. Three things follow from that, each one a hole a spelled base left open (ADR 0016):
 *
 * - the ground ABOVE the base is judged before a level is touched. `O_NOFOLLOW` guards the last name of an
 *   open and nothing above it, so a user who can write an ancestor can rename the base and leave a link at its
 *   name between two calls here, and every level below resolves on ground nothing judged;
 * - the base entry is looked up under a name with NO trailing separator, because `state/` resolves THROUGH a
 *   link at `state` — the `lstat`, the `O_NOFOLLOW` open and the `fchmod` would all land on the far side;
 * - the levels are the chain the walk reached. A spelled base like `alias/../state` is NOT the path the
 *   kernel takes: `..` steps back out of wherever `alias` physically is, while `path.relative` and `path.join`
 *   would fold it away and hand the descent a different directory than the one judged.
 *
 * The base and the levels under it are what this repair exists to make private, so a `sessions/` left at 0775
 * by umask 002 is repaired rather than refused; only the ANCESTRY refuses.
 *
 * Nothing here decides whether the daemon starts (ADR 0016), so no error is allowed to travel either: the
 * ancestry walk and every `lstat`, `open`, `fstat`, `fchmod` and closing `close` below are inside one catch,
 * and any of them failing — `EACCES` on a directory this user cannot read, `EIO` on an ancestor's `lstat`,
 * `ENOENT` on a name that went missing meanwhile — is reported as a skipped level and stopped there. Creation
 * keeps its own failures, which come from the `mkdir` in the caller. {@link DaemonStateDir} says who reads the
 * answer.
 */
function repairStateChain(
  stateBase: string,
  directory: string,
): Readonly<{ directory: string; privateChain: boolean }> {
  // Windows answers access from an ACL, and `chmod` there only toggles the read-only bit.
  if (process.platform === 'win32') return { directory, privateChain: true };
  let physical: string;
  try {
    // Asked of the base as it is spelled, and answered as the physical directory the kernel's own chain
    // arrives at: the walk judges `..` and aliases the way resolution does, and the base's own name is
    // re-attached unnormalized, so what follows repairs and reports THAT directory.
    const base = verifiedDirectoryPath(stateBase);
    if (!('physical' in base)) {
      skipStateDirMode(base.ancestor, `state_ancestry_${base.exposure}`);
      return { directory, privateChain: false };
    }
    physical = base.physical;
  } catch (error) {
    // The walk itself failed: `EIO` on an ancestor's `lstat`, `EACCES` on a directory above. Nothing is known
    // about this chain, so nothing is touched, and startup is not stopped either — one skip says so.
    skipStateDirMode(stateBase, (error as NodeJS.ErrnoException).code ?? 'state_base_unjudged');
    return { directory, privateChain: false };
  }
  const tail = stateTailBelow(stateBase, directory);
  // A caller that names a directory outside the state base has no chain here to judge it from.
  if (tail === undefined) {
    skipStateDirMode(directory, 'not_below_state_base');
    return { directory, privateChain: false };
  }
  // Every level is a name under the verified base, so the descent is the chain the walk judged, and the
  // answer a caller writes under is that chain's own spelling rather than the configuration string.
  const levels = [
    physical,
    ...tail.map((_, index) => path.join(physical, ...tail.slice(0, index + 1))),
  ];
  const verified = levels.at(-1)!;
  for (const level of levels) {
    try {
      if (!repairStateLevel(level)) return { directory: verified, privateChain: false };
    } catch (error) {
      skipStateDirMode(level, (error as NodeJS.ErrnoException).code ?? 'unknown');
      return { directory: verified, privateChain: false };
    }
  }
  return { directory: verified, privateChain: true };
}

/**
 * The names from `stateBase` down to `directory`, base excluded, or `undefined` if `directory` is not below it.
 * This is the only place a caller's spelling is compared, and it answers NAMES, never a path: {@link
 * repairStateChain} re-attaches them to the verified physical base, so a `..`, an alias or a trailing
 * separator in either argument cannot move a level onto ground nothing judged.
 */
function stateTailBelow(stateBase: string, directory: string): readonly string[] | undefined {
  const below = path.relative(
    stripTrailingSeparators(stateBase),
    stripTrailingSeparators(directory),
  );
  if (below === '' || below === '.') return [];
  if (below === '..' || below.startsWith(`..${path.sep}`) || path.isAbsolute(below))
    return undefined;
  return below.split(path.sep);
}

/** A path with any trailing separators cut off: the name an entry is actually looked up under. */
function stripTrailingSeparators(directory: string): string {
  const stripped = directory.replace(/[/\\]+$/, '');
  return stripped === '' ? directory : stripped;
}

/**
 * Forces one level, and reports whether the chain is intact THROUGH it — the descent may go on beneath it,
 * and the level counts as private ground.
 *
 * `chmod` given the NAME acts on whatever the name resolves to, so the mode goes through a descriptor opened
 * `O_DIRECTORY | O_NOFOLLOW`, and only after that descriptor's `fstat` says this uid owns the entry — the
 * entry the `fchmod` will change is the one asked about, because a writable parent can swap the name between
 * two calls. A LINK or a non-directory is not a level of this tree, and a foreign directory is not this
 * process's to judge, so both stop the descent rather than being followed or forced.
 */
function repairStateLevel(level: string): boolean {
  const judged = fs.lstatSync(level, { bigint: true, throwIfNoEntry: false });
  // The name is gone: whatever removed it also removed the mode this call came to force, and there is
  // nothing below it. Said out loud like every other stop, because the log has to show WHERE it stopped.
  if (judged === undefined) {
    skipStateDirMode(level, 'absent');
    return false;
  }
  // Asked BEFORE the mode, never after it: a LINK whose own bits are 0700 answers the mode question with the
  // private mode, and a repair that read the mode first would pass that link without judging it at all.
  if (!judged.isDirectory()) {
    skipStateDirMode(level, 'not_a_directory');
    return false;
  }
  if (Number(judged.uid) !== (process.getuid?.() ?? -1)) {
    skipStateDirMode(level, 'foreign_owned');
    return false;
  }
  // The fast path: a level that already has the mode needs nothing, and asking nothing of the mount keeps
  // the common start free of an open.
  if ((Number(judged.mode) & 0o777) === STATE_DIR_MODE) return true;
  return forcePrivateStateDir(level);
}

/**
 * Forces one level whose `lstat` passed, through a descriptor that cannot follow a link, and reports whether
 * the entry that open REACHED is this process's to keep private. The `lstat` said so a moment ago, and only
 * the descriptor says what the `fchmod` changed: a name swapped for a link between the two calls is caught
 * here, and a level caught there is NOT private ground, whatever its `lstat` claimed.
 */
function forcePrivateStateDir(level: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      level,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    // The entry this open REACHED, asked before the mode is forced: the name can be swapped for a link
    // between the `lstat` above and this open, and only the descriptor says what the `fchmod` will change.
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

/**
 * Reports the one state level whose mode this repair will not change, and returns nothing: a skip is never a
 * refusal, and a caller that cannot reach a level still gets the directory it asked for.
 */
function skipStateDirMode(level: string, reason: string): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'daemon_state_mode_repair_skipped',
    data: { path: level, reason: `state mode repair stopped at this level: ${reason}` },
  });
}

/**
 * What a mode repair may never fail the daemon on: a host that denies the chmod (`EPERM`, `EROFS`, and the
 * two spellings of an unsupported one), a name that cannot open as a directory (`ELOOP`, `ENOTDIR`), and a
 * directory that will not open for this user at all (`EACCES`).
 */
const MODE_REPAIR_SKIPPED_CODES = new Set([
  'EPERM',
  'EROFS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EACCES',
  'ELOOP',
  'ENOTDIR',
]);

/**
 * Forces a pre-existing state path to the private mode, whatever mode it had. On Windows, chmod
 * only toggles the read-only bit, so it cannot make the path private. The repair never decides
 * whether the daemon starts: a path another user owns, or a mount without chmod, keeps its mode.
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
