import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  identityOf,
  lstatEntry,
  othersCreateEntriesIn,
  pathComponents,
  publishFileSync,
  reportSkippedModeRepair,
  SCRIPT_DIR_MODE,
  scriptAncestryReason,
  scriptTrust,
  untrustedGroundWording,
  walkSpelledParent,
  type ScriptAncestryExposure,
  type ScriptDestinationTrust,
  type WalkGround,
} from './atomic-file.ts';

/**
 * Both guards are the same failure mode seen from two sides — something other than a plain
 * regular file sits at the final path — so the recovery is shared (ADR 0010 §3).
 */
export const NOT_REGULAR_FILE_HINT =
  'agent-device only reads and writes regular files at this path. Remove the symbolic link or special file there and retry.';
const CONCURRENT_REPLACEMENT_HINT =
  'Another process replaced the file at this path while it was being opened. Stop the concurrent writer, then retry.';

/**
 * Opens a regular final-path file for verified reads, or returns absent. A FIFO swapped in after the `lstat`
 * opens at once with O_NONBLOCK and is refused by the identity check, instead of waiting for a writer.
 */
export function openVerifiedFileForRead(pathname: string): number | undefined {
  return openVerifiedFile(pathname, fs.constants.O_RDONLY | optionalNonBlockFlag(), false);
}

/** Opens or creates a verified regular final-path file with atomic append semantics. */
export function openVerifiedFileForAppend(pathname: string): number {
  return openVerifiedFile(pathname, fs.constants.O_WRONLY | fs.constants.O_APPEND, true)!;
}

/** Opens or creates a verified regular final-path file, then truncates only through that fd. */
export function openVerifiedFileForTruncate(pathname: string): number {
  const descriptor = openVerifiedFile(pathname, fs.constants.O_RDWR, true)!;
  try {
    fs.ftruncateSync(descriptor, 0);
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function openVerifiedFile(
  pathname: string,
  accessFlags: number,
  create: boolean,
): number | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = attemptVerifiedOpen(pathname, accessFlags, create);
    if (result.status === 'retry') continue;
    return result.status === 'missing' ? undefined : result.descriptor;
  }
  throw new AppError(
    'COMMAND_FAILED',
    `Final file could not be opened without an identity race: ${pathname}`,
    { hint: CONCURRENT_REPLACEMENT_HINT },
  );
}

type VerifiedOpenAttempt =
  | Readonly<{ status: 'opened'; descriptor: number }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'retry' }>;

function attemptVerifiedOpen(
  pathname: string,
  accessFlags: number,
  create: boolean,
): VerifiedOpenAttempt {
  const before = lstatRegularFile(pathname);
  if (!before && !create) return { status: 'missing' };
  const opened = openCandidate(pathname, accessFlags, before === undefined, create);
  if (typeof opened !== 'number') return opened;
  try {
    assertOpenedIdentity(pathname, opened, before);
    return { status: 'opened', descriptor: opened };
  } catch (error) {
    fs.closeSync(opened);
    throw error;
  }
}

function openCandidate(
  pathname: string,
  accessFlags: number,
  creating: boolean,
  create: boolean,
): number | Readonly<{ status: 'missing' | 'retry' }> {
  try {
    return fs.openSync(
      pathname,
      accessFlags |
        optionalNoFollowFlag() |
        (creating ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0),
      0o600,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const recovery = recoverableOpenFailure(code, creating, create);
    if (recovery) return recovery;
    throw error;
  }
}

function recoverableOpenFailure(
  code: string | undefined,
  creating: boolean,
  create: boolean,
): Readonly<{ status: 'missing' | 'retry' }> | undefined {
  if (code === 'EEXIST') return creating ? { status: 'retry' } : undefined;
  if (code !== 'ENOENT') return undefined;
  if (creating) return undefined;
  return { status: create ? 'retry' : 'missing' };
}

function assertOpenedIdentity(pathname: string, descriptor: number, before?: fs.Stats): void {
  const opened = fs.fstatSync(descriptor);
  const after = lstatRegularFile(pathname);
  if (!opened.isFile()) throw identityChangedError(pathname);
  if (!after) throw identityChangedError(pathname);
  if (!sameFile(opened, after)) throw identityChangedError(pathname);
  if (before && !sameFile(before, opened)) throw identityChangedError(pathname);
}

function identityChangedError(pathname: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Final file identity changed while it was opened: ${pathname}`,
    { hint: CONCURRENT_REPLACEMENT_HINT },
  );
}

function lstatRegularFile(pathname: string): fs.Stats | undefined {
  const stats = lstatIfPresent(pathname);
  if (stats && !stats.isFile()) {
    throw new AppError('COMMAND_FAILED', `Final path must be a regular file: ${pathname}`, {
      hint: NOT_REGULAR_FILE_HINT,
    });
  }
  return stats;
}

/** `lstat` that treats absence as `undefined`; every other errno propagates. */
export function lstatIfPresent(pathname: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Refuses an occupied script destination before dispatch, including dangling final links. */
export function assertScriptTargetVacant(destination: string): void {
  try {
    if (!lstatIfPresent(destination)) return;
  } catch {
    // Delivery judges the ancestry and commits exclusively when this probe cannot establish occupancy.
    return;
  }
  throw new AppError('COMMAND_FAILED', `A file already exists at ${destination}.`, {
    reason: 'script_target_exists',
    path: destination,
    hint: 'Choose another output path or pass --force/--overwrite.',
  });
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function optionalNonBlockFlag(): number {
  const nonBlock = fs.constants.O_NONBLOCK;
  return Number.isInteger(nonBlock) && nonBlock > 0 ? nonBlock : 0;
}

function optionalNoFollowFlag(): number {
  const noFollow = fs.constants.O_NOFOLLOW;
  return Number.isInteger(noFollow) && noFollow > 0 ? noFollow : 0;
}

/* ---------------------------------------------------------------------------
 * State files (#4649): the startup marker, the shutdown report, the daemon log handle.
 *
 * Each one is something the daemon writes or reads in a directory it chose for itself, so each asks the
 * chain rule FIRST and the verified open SECOND. The chain answers who else can reach the directory; the
 * verified open answers what stands at the final name. A refusal is not a crash and not a read of somebody
 * else's bytes: a state record the daemon cannot vouch for is one it does not have.
 *
 * Every state append goes through host-kit's ONE verified append opener, and every state read through the
 * ONE verified read opener. Node exposes no descriptor-relative create or rename, so "binding a state write
 * to the judged directory" is spelled as the strongest thing the host does have: the entry is spelled FROM
 * the judged directory, opened `O_NOFOLLOW`, and the descriptor is proved to reach the entry the look
 * described.
 * ------------------------------------------------------------------------- */

/** The state file's judged landing spot: the entry spelled FROM the judged directory, never from the caller. */
function stateEntry(
  pathname: string,
):
  | Readonly<{ destination: string; exposure: undefined }>
  | Readonly<{ destination: undefined; exposure: PrivateDirectoryExposure }> {
  const chain = judgePrivateDirectoryChain(path.dirname(pathname));
  if (chain.exposure) return { destination: undefined, exposure: chain.exposure };
  // The caller's own spelling is not kept: a `..` or an alias would put a state file, or its temporary
  // sibling, in ground this judgment never read.
  return { destination: path.join(chain.directory, path.basename(pathname)), exposure: undefined };
}

/** The entry a state write must have, or the typed refusal that says why it cannot be had. */
function requiredStateEntry(pathname: string): string {
  const asked = stateEntry(pathname);
  if (asked.destination === undefined) throw stateChainFailure(pathname, asked.exposure);
  return asked.destination;
}

/** The refusal a state writer answers with, naming the path its caller asked about. */
function stateChainFailure(pathname: string, exposure: PrivateDirectoryExposure): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Refusing to write ${pathname}: ${privateDirectoryWordingOf(exposure)}`,
    {
      reason: PRIVATE_STATE_DIR_REASON,
      exposure,
      path: pathname,
      hint: 'Keep the state directory owned by the user that runs agent-device and closed to others, or point AGENT_DEVICE_STATE_DIR at such a directory.',
    },
  );
}

/**
 * Opens one state file for appending and returns the handle, at the mode a state record carries.
 *
 * The mode is said on the OPEN descriptor rather than at a name, so no link can stand between the ask and
 * the change and no `umask` can price the file down. The caller keeps the handle: the daemon's log handle is
 * handed to a spawned process as its stdout and stderr, and a report about a refused path is written through
 * a handle already trusted rather than by going back to that path's name.
 */
export function openPrivateStateFileForAppendSync(pathname: string): number {
  const destination = requiredStateEntry(pathname);
  const descriptor = openVerifiedFileForAppend(destination);
  try {
    fs.fchmodSync(descriptor, PRIVATE_STATE_FILE_MODE);
  } catch (error) {
    reportSkippedModeRepair(destination, error instanceof Error ? error.message : String(error));
  }
  return descriptor;
}

/**
 * Writes one line through a handle this process already trusts.
 *
 * A report about a refused path must not go to that path by name: a FIFO planted there would block the
 * writer, and a link would redirect the very warning about being planted.
 */
export function writePrivateStateLineSync(descriptor: number, line: string): void {
  fs.appendFileSync(descriptor, line, 'utf8');
}

/**
 * {@link openPrivateStateFileForAppendSync} answered as an answer, for a caller that must not fail when the
 * record is refused. The daemon's log handle is the case: a launch that cannot get a verified handle still
 * starts, and carries on with the plain one it has always used.
 */
export function tryOpenPrivateStateFileForAppendSync(
  pathname: string,
):
  | Readonly<{ descriptor: number; failure: undefined }>
  | Readonly<{ descriptor: undefined; failure: unknown }> {
  try {
    return { descriptor: openPrivateStateFileForAppendSync(pathname), failure: undefined };
  } catch (error) {
    return { descriptor: undefined, failure: error };
  }
}

/**
 * Appends one record line to one state file, and repairs the seam a crashed append left.
 *
 * A crash mid-append can leave no trailing newline, and gluing two records makes both unparsable. The last
 * byte is read through host-kit's verified read opener and the line written through its verified append
 * opener; the two are joined by an identity comparison, so glue is only ever added to the bytes it was read
 * from. A replaced entry is refused, never glued.
 */
export function appendPrivateStateFileSync(pathname: string, line: string): void {
  const destination = requiredStateEntry(pathname);
  const seam = readVerifiedTailSync(destination, 1);
  const descriptor = openVerifiedFileForAppend(destination);
  try {
    if (seam !== undefined && !seam.text.endsWith('\n')) {
      if (seam.identity !== identityOf(fs.fstatSync(descriptor, { bigint: true }))) {
        throw new AppError(
          'COMMAND_FAILED',
          `State record changed as it was opened: ${destination}`,
          { reason: PRIVATE_STATE_DIR_REASON, path: destination },
        );
      }
      line = `\n${line}`;
    }
    fs.appendFileSync(descriptor, line, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Publishes one state file: staged in a sibling opened EXCLUSIVELY at 0600 and written through that
 * descriptor, then renamed onto the name, and durable down to the directory entry.
 *
 * A rename replaces a symbolic link at the destination instead of writing through it, and the sibling is
 * cleaned up only while it is still the entry this call created.
 */
export function publishPrivateStateFileSync(pathname: string, contents: string): void {
  publishFileSync({
    destination: requiredStateEntry(pathname),
    contents,
    mode: PRIVATE_STATE_FILE_MODE,
    exactMode: true,
  });
}

/**
 * The last {@link maxBytes} of one state file, or `undefined` when there is nothing trustworthy to read.
 *
 * A refusal reads the same as absence: a record the daemon cannot vouch for is one the caller does not have,
 * and a caller that believed a planted record would be believing what another local user wrote. The open is
 * verified, non-blocking, and the bytes are capped, so a FIFO or an enormous file planted at the name can
 * neither stop a reader nor exhaust it. The answer carries the entry's identity, so a writer that read
 * before it appended can tell whether the entry it read is the entry it holds.
 */
function readVerifiedTailSync(
  pathname: string,
  maxBytes: number,
): Readonly<{ text: string; identity: string }> | undefined {
  const asked = stateEntry(pathname);
  if (asked.destination === undefined) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openVerifiedFileForRead(asked.destination);
    if (descriptor === undefined) return undefined;
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    if (length <= 0) return undefined;
    const buffer = Buffer.alloc(length);
    if (fs.readSync(descriptor, buffer, 0, length, size - length) !== length) return undefined;
    return {
      text: buffer.toString('utf8'),
      identity: identityOf(fs.fstatSync(descriptor, { bigint: true })),
    };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Reading is done; a descriptor the host will not close changes no answer.
      }
    }
  }
}

/** {@link readVerifiedTailSync} answered as text, for a caller that has no use for the identity. */
export function readPrivateStateFileSync(pathname: string, maxBytes: number): string | undefined {
  return readVerifiedTailSync(pathname, maxBytes)?.text;
}

const PRIVATE_STATE_FILE_MODE = 0o600;

/* ---------------------------------------------------------------------------
 * The daemon's own state directory (#4649).
 *
 * A destination a caller names is the caller's own, and `atomic-file.ts` judges it. A state directory is the
 * opposite case: the daemon picked it and writes there unasked. What it writes is only private if the WHOLE
 * route to it is, so the state rule asks the SAME walk the destination rule asks — full ancestry resolved one
 * name at a time from `/`, links where ADR 0016 allows them, so an allowed system alias such as `/var` to
 * `/private/var` still answers — and then asks one thing more: the directory an entry is created in must be
 * closed to entries from other local users, sticky bit or not, because here the daemon CREATES names of its
 * own choosing rather than passing through.
 *
 * Nothing here decides whether a daemon starts. Every refusal is an answer, and a repair is the narrowest
 * action that cannot follow a link. Levels above the state directory are judged and never repaired: the
 * daemon does not choose them, and a home directory is nobody's to tighten.
 * ------------------------------------------------------------------------- */

/** What one state-chain answer permits, and the ground it was judged on. */
/** The typed reason a state refusal answers with, named once for whoever reads it. */
export const PRIVATE_STATE_DIR_REASON = 'state_dir_untrusted';

export type PrivateDirectoryChain = Readonly<{
  /** The RESOLVED directory to create an entry in, spelled from the judged chain, never the caller's. */
  directory: string;
  /** That directory's identity, as the walk's own `lstat` answered it; a writer re-opens and compares. */
  identity: string | undefined;
  /** Why the chain is not private, or `undefined` when it is. */
  exposure: PrivateDirectoryExposure | undefined;
}>;

/**
 * How a state chain fails: what the walk finds on the route, a spelling with no chain at all, and ground this
 * process cannot read at all.
 */
export type PrivateDirectoryExposure =
  | ScriptAncestryExposure
  | 'outside_state_dir'
  | 'state_dir_unreadable';

/**
 * Establishes the state chain, creating what is missing at {@link SCRIPT_DIR_MODE}, and answers typed.
 *
 * The answer, never a warning: a marker is written per startup phase and the state directory is asked again
 * each time, so whoever established the chain reports it once — `establishPrivateDaemonStateDir` does the
 * one stderr line for both daemon entry points. Repair never refuses anything: a level this process does not
 * own is left exactly as it stands.
 */
export function ensurePrivateDirectoryChain(
  stateDir: string,
  names: readonly string[] = [],
): PrivateDirectoryChain {
  return stateChain(stateDir, names, true);
}

/**
 * Judges a chain that must already stand, creating and repairing nothing. Every state file this package
 * writes or reads asks this much of its own directory first; a caller that answers for the state directory
 * itself gets the same question and the same answer.
 */
export function judgePrivateDirectoryChain(
  stateDir: string,
  names: readonly string[] = [],
): PrivateDirectoryChain {
  return stateChain(stateDir, names, false);
}

/**
 * Walks one state route and answers whether this process may write into it.
 *
 * `create` says whether a missing tail is this call's to make. With it, a missing level is created inside
 * the directory the walk just judged, which is also what fills in the ancestors below `$HOME` that nothing
 * else would have made. `repaired` marks the one second pass a narrowable level earns, so a repair can
 * never loop.
 */
function stateChain(
  stateDir: string,
  names: readonly string[],
  create: boolean,
  repaired = false,
): PrivateDirectoryChain {
  const target = spelledStateTarget(stateDir, names);
  if (target === undefined) return refusedStateChain(stateDir, 'outside_state_dir');
  if (process.platform === 'win32') {
    // Access is an ACL here, so no walk runs and `lstat` answers no usable directory identity: one recursive
    // `mkdir`, which is what this host has always done and which forces nothing on a level that stands.
    return createWindowsStateDirectory(target, create);
  }
  const trust = scriptTrust({});
  const arrived = walkStateRoute(target, trust, create);
  if ('refusedOn' in arrived) {
    // A loose level the daemon's OWN state tree is the shared checkout's failure mode — umask 002 is what a
    // group-writable home directory carries — and a daemon that refused its own leftover would break on
    // every restart, so the level is narrowed and the route is judged again. What may be narrowed starts at
    // the state directory: a refusal naming a level ABOVE it is judged and left exactly as it stands,
    // because the daemon did not choose `$HOME` and nobody's home directory is agent-device's to tighten.
    if (
      !repaired &&
      create &&
      repairableStateExposure(arrived.exposure) &&
      standsInsideStateDirectory(target, arrived.refusedOn)
    )
      return repairStateDirectoryAndJudgeAgain(arrived.refusedOn, trust);
    return refusedStateChain(arrived.refusedOn, arrived.exposure);
  }
  // One thing more than the destination rule, and the reason the state rule is not just the walk: a
  // directory other local users can add an entry to is refused however it is dressed. A sticky bit shields
  // other people's entries; it does not win the race to plant `daemon-shutdown.json` first.
  if (othersCreateEntriesIn(arrived.authority, trust)) {
    if (!repaired && create) return repairStateDirectoryAndJudgeAgain(arrived.deepest, trust);
    return refusedStateChain(arrived.deepest, 'shared_parent');
  }
  if (create) narrowDirectoryMode(arrived.deepest, trust);
  return { directory: arrived.deepest, identity: arrived.identity, exposure: undefined };
}

/**
 * Whether `directory` is the state directory itself or one of the levels below it.
 *
 * This is the line the repair draws: below the state directory, every level is a name the daemon picked and
 * can narrow back to the private mode. Above it, the levels belong to somebody else's layout — `$HOME`, a
 * mount point, a shared volume root — and a tool that quietly re-modes them has damaged a host while
 * meaning to protect one. The answer is spelling-based on purpose: a `..` cannot reach here, since a state
 * path that folds one is refused before any walk.
 */
function standsInsideStateDirectory(stateDir: string, directory: string): boolean {
  const relative = path.relative(stateDir, directory);
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The exposures a mode is enough to fix: a level whose OWNERSHIP is fine and whose permission bits are not.
 *
 * `foreign_owned` is not on the list because `chmod` on another user's directory is not this rule's to do,
 * and neither is anything the walk found on the ROUTE — a link, an unreadable level, a missing parent. A
 * repair answers those by leaving them refused.
 */
function repairableStateExposure(exposure: PrivateDirectoryExposure): boolean {
  return (
    exposure === 'world_writable' ||
    exposure === 'shared_group_writable' ||
    exposure === 'shared_parent'
  );
}

/**
 * Narrows `directory` to {@link SCRIPT_DIR_MODE}, reaching ONLY the inode the look judged, and reporting
 * what it could not do.
 *
 * A mode is never said at a NAME, because `chmod` follows a link: the entry is looked up, then opened
 * `O_DIRECTORY | O_NOFOLLOW`, which answers a symbolic link at that name by not opening it at all, and the
 * `fstat` of the open descriptor is compared with the identity that lookup answered. Ownership is decided on
 * the same lookup the rule judges with, so a level belonging to another local user — root's included — is
 * left alone. Any step that fails is a skip with a diagnostic: a repair is never an outcome.
 */
function narrowDirectoryMode(directory: string, trust: ScriptDestinationTrust): void {
  const seen = lstatEntry(directory);
  if (seen === undefined || !seen.isDirectory()) return;
  if (Number(seen.uid) !== trust.uid) return;
  if ((Number(seen.mode) & 0o777) === SCRIPT_DIR_MODE) return;
  const flags = directoryNoFollowOpenFlags();
  if (flags === undefined) {
    reportSkippedModeRepair(directory, 'this host cannot open a directory without following links');
    return;
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, flags);
    const stood = fs.fstatSync(descriptor, { bigint: true });
    if (identityOf(stood) !== identityOf(seen))
      throw new Error('directory changed as it was opened');
    fs.fchmodSync(descriptor, SCRIPT_DIR_MODE);
  } catch (error) {
    reportSkippedModeRepair(directory, error instanceof Error ? error.message : String(error));
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor is the last thing this needed from that directory.
      }
    }
  }
}

/** Narrows the judged state directory and judges the route again, once. */
function repairStateDirectoryAndJudgeAgain(
  target: string,
  trust: ScriptDestinationTrust,
): PrivateDirectoryChain {
  narrowDirectoryMode(target, trust);
  return stateChain(target, [], true, true);
}

/**
 * `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`, or `undefined` where the host does not name all three. Absent flags
 * mean no repair: a host that cannot refuse to follow a link cannot promise the mode lands on the judged
 * inode, and an unmade repair is a skip, never a guess.
 *
 * `O_RDONLY` is the one access flag whose value is ZERO on the supported hosts, so it is asked for as
 * "an integer this host names" while the two flags that carry the safety are asked for as non-zero.
 */
function directoryNoFollowOpenFlags(): number | undefined {
  const access = fs.constants.O_RDONLY;
  const guards = [fs.constants.O_DIRECTORY, fs.constants.O_NOFOLLOW];
  if (!Number.isInteger(access)) return undefined;
  if (!guards.every((flag) => Number.isInteger(flag) && Number(flag) > 0)) return undefined;
  return guards.reduce((all, flag) => all | Number(flag), Number(access));
}

/**
 * The chain's spelling, refused when there is none.
 *
 * A `..` has no answer here. Folding one away is what sends a state path OUTSIDE the state directory
 * through a link, and the writer would then be told about a directory it never named.
 */
function spelledStateTarget(stateDir: string, names: readonly string[]): string | undefined {
  if (!path.isAbsolute(stateDir)) return undefined;
  const oneName = (name: string): boolean =>
    name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
  if (!names.every(oneName)) return undefined;
  const target = path.join(path.resolve(stateDir), ...names);
  return pathComponents(target).includes('..') ? undefined : target;
}

/** A chain that is not this process's own, answered with the level that made it so. */
function refusedStateChain(
  directory: string,
  exposure: PrivateDirectoryExposure,
): PrivateDirectoryChain {
  return { directory, identity: undefined, exposure };
}

/** A state directory on a host whose access is an ACL; the create asks no identity, so the answer says so. */
function createWindowsStateDirectory(target: string, create: boolean): PrivateDirectoryChain {
  if (!create) return { directory: target, identity: undefined, exposure: undefined };
  try {
    fs.mkdirSync(target, { recursive: true, mode: SCRIPT_DIR_MODE });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return refusedStateChain(
      path.dirname(target),
      code === 'ENOENT' ? 'unreachable_parent' : 'not_a_directory',
    );
  }
  return { directory: target, identity: undefined, exposure: undefined };
}

/**
 * The destination walk, asked for a state route: it refuses by throwing an `AppError` whose typed `exposure`
 * and `ancestor` are exactly this answer, and a failed LOOKUP is turned into that same answer here, so no
 * caller of the state rule ever receives a raw errno.
 *
 * `lstat` answers absence as "no entry", but EACCES, ENOTDIR and ELOOP escape as errors, and a state path
 * below a directory this process cannot read is a fact about the host, not a crash. A daemon that hit one
 * during startup used to lose the process before its first marker; here it is one more exposure, and the
 * caller that asked best-effort keeps going.
 */
function walkStateRoute(
  target: string,
  trust: ScriptDestinationTrust,
  create: boolean,
): WalkGround | Readonly<{ refusedOn: string; exposure: PrivateDirectoryExposure }> {
  try {
    return walkSpelledParent(target, target, trust, create);
  } catch (error) {
    const exposure = stateExposureOf(error);
    if (exposure !== undefined) return { refusedOn: stateAncestorOf(error) ?? target, exposure };
    const lookup = stateLookupExposureOf(error);
    if (lookup !== undefined) return { refusedOn: target, exposure: lookup };
    throw error;
  }
}

/** The state refusal this walk carries, or `undefined` for an error from somewhere else. */
function stateExposureOf(error: unknown): PrivateDirectoryExposure | undefined {
  const reason = scriptAncestryReason(error);
  if (reason === undefined) return undefined;
  const exposure = error instanceof AppError ? error.details?.exposure : undefined;
  return typeof exposure === 'string' && exposure in untrustedGroundWording
    ? (exposure as ScriptAncestryExposure)
    : undefined;
}

function stateAncestorOf(error: unknown): string | undefined {
  const ancestor = error instanceof AppError ? error.details?.ancestor : undefined;
  return typeof ancestor === 'string' ? ancestor : undefined;
}

/**
 * The exposure one failed filesystem LOOKUP means, or `undefined` for an error this rule has no answer for.
 *
 * Only the lookup errnos a state path can meet on the way in are converted. Anything else — an out-of-space
 * create, a host that fails a syscall for a reason nobody modelled — is left to propagate, because a rule
 * that answered for everything would answer "not private" about a failing disk.
 */
function stateLookupExposureOf(error: unknown): PrivateDirectoryExposure | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'state_dir_unreadable';
  if (code === 'ENOTDIR') return 'not_a_directory';
  if (code === 'ELOOP') return 'link_loop_exceeded';
  return undefined;
}

/** Where the shared ground wording says "script" and a state path needs to say "state file". */
const stateGroundWording: Partial<Record<ScriptAncestryExposure, string>> = {
  planted_link:
    'a symbolic link stands on that part of the path. Below a state directory chosen with AGENT_DEVICE_STATE_DIR, that link may be one you made yourself; choose a state path with no link on it.',
  shared_parent: "another local user could create one of the daemon's state files there first.",
  link_loop_exceeded:
    'that part of the state path follows more symbolic links than the system allows, so where the state file would land is not established.',
  unreachable_parent:
    'that part of the state path is not there and cannot be created there, so nothing has a place to be written.',
  unresolvable_parent:
    'the state path names a directory that does not exist and steps back out of it with `..`, so where the state file would land is not established.',
  relative_destination:
    'the state path has to be absolute, so the directories it names are the ones that get checked.',
};

/** Why each exposure makes that ground unsafe, in the caller's terms. */
export function privateDirectoryWordingOf(exposure: PrivateDirectoryExposure): string {
  if (exposure === 'outside_state_dir') {
    return (
      'the state path steps out of the directory it starts in, so where it lands is not established. ' +
      'Keep every state file name directly inside the state directory.'
    );
  }
  if (exposure === 'state_dir_unreadable') {
    return (
      'this process cannot read that part of the state path, so it cannot tell who could write there. ' +
      'Make the state directory readable and owned by the user that runs agent-device, or point ' +
      'AGENT_DEVICE_STATE_DIR at such a directory.'
    );
  }
  return stateGroundWording[exposure] ?? untrustedGroundWording[exposure];
}
