import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from './diagnostics.ts';
import {
  identityOf,
  lstatEntry,
  lstatIfPresent,
  othersCreateEntriesIn,
  pathComponents,
  publishFileSync,
  SCRIPT_DIR_MODE,
  scriptAncestryReason,
  scriptTrust,
  untrustedGroundWording,
  walkSpelledParent,
  type ScriptAncestryExposure,
  type ScriptDestinationTrust,
  type WalkGround,
  type WalkPolicy,
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

/**
 * Opens or creates a verified regular final-path file for writing, and empties NOTHING.
 *
 * The state truncate purpose asks for this rather than for `O_TRUNC`: an open flag would empty the bytes
 * before anything said whose they are.
 */
function openVerifiedFileForWrite(pathname: string): number {
  return openVerifiedFile(pathname, fs.constants.O_RDWR, true)!;
}

/** Opens or creates a verified regular final-path file, then truncates only through that fd. */
export function openVerifiedFileForTruncate(pathname: string): number {
  const descriptor = openVerifiedFileForWrite(pathname);
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

/** Whether two `lstat` answers describe the one inode. */
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

/**
 * The state file's judged landing spot: the entry spelled FROM the judged directory, never from the caller,
 * together with the identity the walk gave that directory.
 *
 * The identity travels with the destination, so the I/O owner can prove the ground is still the ground that
 * was judged before a byte goes out. A state directory that was moved and replaced between the judgment and
 * the write is a different directory, and its entries belong to whatever now stands there.
 */
function stateEntry(pathname: string):
  | Readonly<{
      destination: string;
      directory: string;
      identity: string | undefined;
      exposure: undefined;
    }>
  | Readonly<{
      destination: undefined;
      directory: undefined;
      identity: undefined;
      exposure: PrivateDirectoryExposure;
    }> {
  const chain = judgePrivateDirectoryChain(path.dirname(pathname));
  if (chain.exposure) {
    return {
      destination: undefined,
      directory: undefined,
      identity: undefined,
      exposure: chain.exposure,
    };
  }
  // The caller's own spelling is not kept: a `..` or an alias would put a state file, or its temporary
  // sibling, in ground this judgment never read.
  return {
    destination: path.join(chain.directory, path.basename(pathname)),
    directory: chain.directory,
    identity: chain.identity,
    exposure: undefined,
  };
}

/**
 * Writes one state record, or throws the typed refusal that says why it cannot be had.
 *
 * The record owners are the callers that have a startup or a shutdown report to account for and answer for the
 * failure themselves; a caller that must not fail takes {@link tryOpenPrivateStateFileSync}.
 */
function requiredStateEntry(pathname: string): Readonly<{
  destination: string;
  directory: string;
  identity: string | undefined;
}> {
  const asked = stateEntry(pathname);
  if (asked.destination === undefined)
    throw stateRefusal(pathname, asked.exposure, privateDirectoryWordingOf(asked.exposure));
  return asked;
}

/**
 * Proves the directory a state entry is spelled in is still the one the chain judged.
 *
 * One `lstat` of the judged directory, compared with the identity the walk's own `lstat` answered. A directory
 * that was renamed away and replaced, or removed and made again, is a different inode: its names are then
 * another process's, and a marker or a report written into it answers a question about this daemon with bytes
 * that daemon did not place. Absence is the same refusal.
 */
function assertStateDirectoryJudged(
  asked: Readonly<{ destination: string; directory: string; identity: string | undefined }>,
): void {
  if (asked.identity === undefined) return;
  const standing = lstatEntry(asked.directory);
  if (standing !== undefined && identityOf(standing) === asked.identity) return;
  throw stateRefusal(
    asked.destination,
    'parent_replaced',
    'the state directory changed as it was opened. Keep the state directory in place while agent-device runs, ' +
      'or point AGENT_DEVICE_STATE_DIR at a directory nothing else replaces.',
  );
}

/** The refusal every state rule answers with, naming the path its caller asked about. */
function stateRefusal(
  pathname: string,
  exposure: PrivateDirectoryExposure,
  remedy: string,
): AppError {
  return new AppError('COMMAND_FAILED', `Refusing to write ${pathname}: ${remedy}`, {
    reason: PRIVATE_STATE_DIR_REASON,
    exposure,
    path: pathname,
    hint: remedy,
  });
}

/**
 * The ONE state open boundary: judge the directory, spell the entry from it, open it without following
 * anything, and prove both the directory and the entry are what the judgment described.
 *
 * Every state write goes through here so no opener is left that asks less. `purpose` is the one thing the caller
 * says about the entry. `append` is a record line going to the end; `append-readable` is the same for a writer
 * that reads the tail through the same handle; `truncate` is the daemon's log, where the daemon's own stdout and
 * stderr already stand open on the inode and the file must be emptied WITHOUT being replaced.
 *
 * NOTHING is emptied or written before the proof. A truncation asked as an open flag (`O_TRUNC`) would empty the
 * bytes a moment before this function says whose they are: a record given a second name by a hard link would
 * stand verified at the open and then be refused for its names, with its contents already gone. So the truncate
 * purpose opens `O_RDWR`, and the emptying is `ftruncate` on the proved descriptor — after the entry's uid, its
 * one name and the directory's identity are all established, and pinned to that one inode either way.
 *
 * A refusal closes the descriptor it had already opened: a rule that walked away from a handle in a long-lived
 * daemon leaked one per refusal.
 */
function openStateEntrySync(pathname: string, purpose: PrivateStateOpenPurpose): number {
  const asked = requiredStateEntry(pathname);
  assertStateDirectoryJudged(asked);
  const descriptor = OPEN_STATE_ENTRY[purpose](asked.destination);
  try {
    assertPrivateStateDescriptor(descriptor, asked.destination);
    assertStateDirectoryJudged(asked);
    if (purpose === 'truncate') fs.ftruncateSync(descriptor, 0);
    return descriptor;
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // The refusal is the answer; a descriptor the host will not close changes it not.
    }
    throw error;
  }
}

/**
 * {@link openStateEntrySync} answered as an answer, for a caller that must not fail over a refused record.
 *
 * No daemon may lose a startup over its log: a launch that cannot get a verified handle still starts, and an
 * unmade truncation costs a run its previous log lines and never this one's.
 */
export function tryOpenPrivateStateFileSync(
  pathname: string,
  purpose: PrivateStateOpenPurpose,
):
  | Readonly<{ descriptor: number; failure: undefined }>
  | Readonly<{ descriptor: undefined; failure: unknown }> {
  try {
    return { descriptor: openStateEntrySync(pathname, purpose), failure: undefined };
  } catch (error) {
    return { descriptor: undefined, failure: error };
  }
}

/** How a state entry is about to be used, which is what decides the flags its open asks for. */
export type PrivateStateOpenPurpose = 'append' | 'append-readable' | 'truncate';

/**
 * The one seam each purpose opens through, all of them link-free and judged.
 *
 * `append-readable` is the state record's own case: the writer reads the last byte THROUGH the handle it is
 * about to append to, to see whether a crashed run left the file without its newline. One handle cannot carry
 * two access modes, so the seam reader asks both at once, and `readSync` at an explicit offset is what reads the
 * tail while `O_APPEND` is still what makes the write go to the end.
 *
 * `truncate` opens read-write and empties NOTHING: the caller empties it on the proved descriptor, so a record
 * this call goes on to refuse keeps the bytes it had.
 */
const OPEN_STATE_ENTRY: Record<PrivateStateOpenPurpose, (destination: string) => number> = {
  append: openVerifiedFileForAppend,
  'append-readable': (destination) =>
    openVerifiedFile(destination, fs.constants.O_RDWR | fs.constants.O_APPEND, true)!,
  truncate: openVerifiedFileForWrite,
};

/**
 * What the bytes behind a state descriptor are, answered as the exposure the state rule speaks, or
 * `undefined` when they are this process's own to use.
 *
 * A verified open says the NAME is a regular file this call reached without following anything. It does not
 * say who ELSE holds those bytes: a record planted by an earlier attacker, or given a second name by a hard
 * link, is content this process did not establish — writing to it would answer a question about this run out
 * of somebody else's file, and reading it would answer one with bytes that run did not place. So the
 * descriptor's own `fstat` is asked two things: the uid is this process's, and the entry has one name.
 */
function privateStateDescriptorExposure(
  held: fs.BigIntStats,
): PrivateDirectoryExposure | undefined {
  const uid = process.getuid?.();
  if (uid !== undefined && Number(held.uid) !== uid) return 'foreign_owned';
  // A second name is not something `fchmod` can take away, and not something a reader can attribute.
  if (Number(held.nlink) !== 1) return 'shared_parent';
  return undefined;
}

/**
 * Proves the bytes behind a state descriptor are this process's own to write, and narrows their mode.
 *
 * An entry this process owns and has one name for is its own whatever mode it stands at, so a wider mode is
 * narrowed rather than refused — on the DESCRIPTOR, the one seam where no link can stand between the ask and
 * the change. A caller that keeps the handle past this call asks {@link assertPrivateStateFileModeSync} and
 * refuses the route when the mode cannot be had; an opener that hands the handle to a caller which treats a
 * loose mode as a warning reports the skip instead.
 */
function assertPrivateStateDescriptor(descriptor: number, destination: string): void {
  const held = fs.fstatSync(descriptor, { bigint: true });
  const exposure = privateStateDescriptorExposure(held);
  if (exposure === 'foreign_owned') {
    throw stateRefusal(
      destination,
      exposure,
      'another local user owns that record. Remove the record at that name; agent-device will make its own.',
    );
  }
  if (exposure === 'shared_parent') {
    throw stateRefusal(
      destination,
      exposure,
      `that record has ${String(held.nlink)} names. Remove the record at that name; ` +
        'agent-device will make its own.',
    );
  }
  try {
    assertPrivateStateFileModeSync(descriptor);
  } catch (error) {
    reportSkippedModeRepair(destination, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Makes the bytes behind a descriptor carry the state file's mode, and PROVES they do.
 *
 * The mode is said on the descriptor and then read back from it, because a caller that keeps this handle is
 * going to write through it for as long as it lives: an `fchmod` the host refused, or a filesystem that will
 * not carry the mode at all, would otherwise leave a record readable by every local user while the process
 * that wrote it believed the state rule had said 0600. The read-back is the whole of the difference — and it
 * is the check a caller cannot make afterwards, since by then the handle is in use.
 */
export function assertPrivateStateFileModeSync(descriptor: number): void {
  fs.fchmodSync(descriptor, PRIVATE_STATE_FILE_MODE);
  const mode = Number(fs.fstatSync(descriptor, { bigint: true }).mode) & 0o777;
  if (mode !== PRIVATE_STATE_FILE_MODE) {
    throw new Error(`this host left the record at mode ${mode.toString(8)} instead of 600`);
  }
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
 * Appends one record line to one state file, and repairs the seam a crashed append left.
 *
 * A crash mid-append can leave no trailing newline, and gluing two records makes both unparsable. The last byte
 * is read THROUGH the same append handle the line goes to, so the glue is added to the bytes it was read from
 * by construction: one open, no window between a read and a write for the entry to be replaced in, and no
 * second opener to disagree with the first about what stands at the name.
 *
 * A refusal THROWS: the caller writes a marker or a report this run has to account for, and an unrecorded phase
 * is a wrong answer rather than a smaller one. The daemon's log handle is the opposite case and takes
 * {@link tryOpenPrivateStateFileSync}.
 */
export function appendPrivateStateFileSync(pathname: string, line: string): void {
  const descriptor = openStateEntrySync(pathname, 'append-readable');
  try {
    if (!lastByteEndsALine(descriptor)) line = `\n${line}`;
    fs.appendFileSync(descriptor, line, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Whether the bytes behind an append handle already end with a newline, or hold nothing at all.
 *
 * The size and the byte both come from the descriptor, so a record that was never written (size zero) and one
 * that already ends cleanly both answer "nothing to glue".
 */
function lastByteEndsALine(descriptor: number): boolean {
  const size = fs.fstatSync(descriptor).size;
  if (size === 0) return true;
  const last = Buffer.alloc(1);
  if (fs.readSync(descriptor, last, 0, 1, size - 1) !== 1) return true;
  return last[0] === 0x0a;
}

/**
 * Publishes one state file: staged in a sibling opened EXCLUSIVELY at 0600 and written through that
 * descriptor, then renamed onto the name.
 *
 * A rename replaces a symbolic link at the destination instead of writing through it, the sibling goes beside
 * the entry spelled FROM the judged directory, and the sibling is cleaned up only while it is still the entry
 * this call created.
 *
 * The judged directory is re-asserted at BOTH seams the staging owner asks its destination guard — once
 * before the sibling is first written and once immediately before the rename commits. A state directory
 * renamed away and made again while the sibling was being written is a different directory's ground by commit
 * time, and a rename onto it would move bytes judged in one directory into another's names.
 */
export function publishPrivateStateFileSync(pathname: string, contents: string): void {
  const asked = requiredStateEntry(pathname);
  assertStateDirectoryJudged(asked);
  const judgeTheDirectory = () => assertStateDirectoryJudged(asked);
  publishFileSync({
    destination: asked.destination,
    contents,
    mode: PRIVATE_STATE_FILE_MODE,
    exactMode: true,
    // The same judgment at both seams the NAME is written at, and again before the sibling this call created
    // is removed: bytes judged in one directory must not be committed into, or tidied up out of, another's.
    assertDestination: judgeTheDirectory,
    assertStagedIn: judgeTheDirectory,
  });
}

/**
 * How far one state read got, said as an answer rather than folded into "no file".
 *
 * A caller that only wants the bytes folds this to `undefined`. A caller that has to decide something about the
 * daemon's health cannot: a startup observer that read no marker because the state chain refused it has learned
 * about the host, not about the daemon, and treating the two alike would report a refused record as a daemon
 * that stopped making progress.
 */
export type PrivateStateRead =
  | Readonly<{ status: 'read'; text: string }>
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'refused' }>;

/**
 * Reads at most {@link maxBytes} of one state file through the state boundary.
 *
 * A refusal reads as a refusal, never as bytes: a record the rule cannot vouch for is one the caller does not
 * have, and a caller that believed a planted record would be believing what another local user wrote. The open
 * is verified and non-blocking, so a FIFO or a link planted at the name can neither stop a reader nor steer it.
 *
 * `whole` says what the bound means. A TAIL read takes the last bytes and is what a log or a phase marker is
 * read for; the bound only caps the cost. A WHOLE read takes the first bytes and REFUSES an entry longer than
 * the bound, because a JSON record cut from the front is no record, and one cut from the BACK is: an enormous
 * file padded at the front would hand a tail reader a perfectly parsable report that this daemon never wrote.
 */
function readStateEntrySync(pathname: string, maxBytes: number, whole: boolean): PrivateStateRead {
  const asked = stateEntry(pathname);
  if (asked.destination === undefined) return { status: 'refused' };
  let descriptor: number | undefined;
  try {
    assertStateDirectoryJudged(asked);
    descriptor = openVerifiedFileForRead(asked.destination);
    if (descriptor === undefined) return { status: 'absent' };
    // Parent AND descriptor authority are asked of a read too, AFTER the open. A directory renamed away
    // and made again between the walk and this open would hand back bytes from some other directory's
    // records; bytes another local user owns, or that stand under a second name, would answer a question
    // about this daemon with a record this daemon did not place. A verified read proves the NAME is a
    // regular file reached without following anything, which is less than this asks of the handle.
    assertStateDirectoryJudged(asked);
    if (privateStateDescriptorExposure(fs.fstatSync(descriptor, { bigint: true })))
      return { status: 'refused' };
    const size = fs.fstatSync(descriptor).size;
    if (size === 0) return { status: 'absent' };
    // A WHOLE read's bound is a rule about the entry, not a cost cap: an entry too long to be one record is not
    // a record, and the answer is the refusal it is rather than bytes dressed up as one.
    if (whole && size > maxBytes) return { status: 'refused' };
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (fs.readSync(descriptor, buffer, 0, length, size - length) !== length)
      return { status: 'refused' };
    return { status: 'read', text: buffer.toString('utf8') };
  } catch {
    return { status: 'refused' };
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

/**
 * The last {@link maxBytes} of one state file, read through the state boundary, answered with WHY it has none.
 *
 * A caller that only wants bytes takes `.text` from the `read` case, and absence and refusal both answer
 * `undefined` there. A caller judging a daemon's health takes the whole answer: {@link PrivateStateRead} is the
 * reason this is not just a string, and a marker read that the state chain refused says something about the
 * host that a missing marker does not.
 */
export function readPrivateStateFileTailSync(pathname: string, maxBytes: number): PrivateStateRead {
  return readStateEntrySync(pathname, maxBytes, false);
}

/**
 * One whole state file of at most {@link maxBytes}, or `undefined` when it is refused OR too long to be one.
 *
 * A bound that silently keeps the tail is no bound for a record that is read as a whole: it turns the padding
 * in front of a planted report into an answer. A daemon writes its reports well inside this bound, so a longer
 * entry is not a big report, it is not a report.
 */
export function readPrivateStateWholeFileSync(
  pathname: string,
  maxBytes: number,
): string | undefined {
  const read = readStateEntrySync(pathname, maxBytes, true);
  return read.status === 'read' ? read.text : undefined;
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

/** The typed reason a state refusal answers with, named once for whoever reads it. */
export const PRIVATE_STATE_DIR_REASON = 'state_dir_untrusted';

/** What one state-chain answer permits, and the ground it was judged on. */
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
  // The state root's own name, counted from the route the walk takes: from that name down the walk refuses a
  // link and refuses ground other local users can add a name to, and a refusal about it or below it is the only
  // one this rule may repair. Positions are the walk's, not spellings, so an allowed ancestor alias such as
  // `/var` neither trips the link rule nor hides the state directory from the repair gate.
  const stateRootRouteName = pathComponents(path.resolve(stateDir)).length - 1;
  const policy: WalkPolicy = {
    noLinksAtRouteNameOrBelow: stateRootRouteName,
    // Every level of the daemon's own route, not just the one an entry is created in: a state file written
    // from a directory reached through a level another local user can plant a name in is a record whose route
    // somebody else chose, and a sticky bit does not stop that planting.
    sharedLevelRefusedOnRoute: true,
    refusal: { atRouteName: undefined },
  };
  const arrived = walkStateRoute(target, trust, create, policy);
  if ('refusedOn' in arrived) {
    // A loose level the daemon's OWN state tree is the shared checkout's failure mode — umask 002 is what a
    // group-writable home directory carries — and a daemon that refused its own leftover would break on
    // every restart, so the level is narrowed and the route is judged again. Only a refusal about the state
    // directory itself or a level below it is narrowed: one about a level ABOVE it is judged and left exactly
    // as it stands, because the daemon did not choose `$HOME` and nobody's home directory is agent-device's to
    // tighten. The walk answers that question, and not a comparison of paths: the walk spells the ground it
    // ARRIVED AT, so a state directory reached through an allowed alias refuses under a spelling that no text
    // comparison with the caller's path would match, and would stay loose forever.
    if (
      !repaired &&
      create &&
      repairableStateExposure(arrived.exposure) &&
      policy.refusal?.atRouteName !== undefined &&
      policy.refusal.atRouteName >= stateRootRouteName
    ) {
      return repairStateDirectoryAndJudgeAgain(stateDir, names, arrived.refusedOn, trust);
    }
    return refusedStateChain(arrived.refusedOn, arrived.exposure);
  }
  // One thing more than the destination rule, and the reason the state rule is not just the walk: a directory
  // other local users can add an entry to is refused however it is dressed. A sticky bit shields other
  // people's entries; it does not win the race to plant `daemon-shutdown.json` first. The walk stood on every
  // level of the route, so this asks of each one and not only of the last.
  if (othersCreateEntriesIn(arrived.authority, trust)) {
    if (!repaired && create) {
      return repairStateDirectoryAndJudgeAgain(stateDir, names, arrived.deepest, trust);
    }
    return refusedStateChain(arrived.deepest, 'shared_parent');
  }
  if (create) narrowDirectoryMode(arrived.deepest, trust);
  return { directory: arrived.deepest, identity: arrived.identity, exposure: undefined };
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
 * Says one state mode the host would not carry, and moves on. The phase is the one a launch has always
 * reported: a repair is never an outcome, so it is written down and the judgment goes on reading the mode
 * that actually stands.
 */
function reportSkippedModeRepair(target: string, reason: string): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'daemon_state_mode_repair_skipped',
    data: { path: target, error: reason },
  });
}

/**
 * Narrows `directory` to {@link SCRIPT_DIR_MODE}, reaching ONLY the inode this call just judged.
 *
 * A mode is never said at a NAME, because `chmod` follows a link: the entry is looked up, then opened
 * `O_DIRECTORY | O_NOFOLLOW`, which answers a symbolic link at that name by not opening it at all, and the
 * `fstat` of the open descriptor is compared with the identity that lookup answered. Ownership is decided on
 * the same lookup the rule judges with, so a level belonging to another local user — root's included — is left
 * alone. Every lookup is inside the guard, so a host that fails one for a reason this rule does not model costs
 * the narrowing and not the caller: establishment is best effort, and a repair is never an outcome.
 */
function narrowDirectoryMode(directory: string, trust: ScriptDestinationTrust): void {
  let descriptor: number | undefined;
  try {
    const seen = lstatEntry(directory);
    if (seen === undefined || !seen.isDirectory()) return;
    if (Number(seen.uid) !== trust.uid) return;
    if ((Number(seen.mode) & 0o777) === SCRIPT_DIR_MODE) return;
    const flags = directoryNoFollowOpenFlags();
    if (flags === undefined) {
      reportSkippedModeRepair(
        directory,
        'this host cannot open a directory without following links',
      );
      return;
    }
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

/**
 * `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`, or `undefined` where the host does not name all three. Absent flags
 * mean no narrowing: a host that cannot refuse to follow a link cannot promise the mode lands on the judged
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
 * Narrows the judged state directory and judges the ROUTE THE CALLER ASKED FOR again, once.
 *
 * The re-judgment asks the caller's own `names` and not just the state directory: the repair happened at the
 * state root, and the levels below it are what the caller came for, so an answer that stopped at the root
 * would report a chain the caller never asked about and send it into a write whose own directory was never
 * judged.
 */
function repairStateDirectoryAndJudgeAgain(
  stateDir: string,
  names: readonly string[],
  target: string,
  trust: ScriptDestinationTrust,
): PrivateDirectoryChain {
  narrowDirectoryMode(target, trust);
  return stateChain(stateDir, names, true, true);
}

/**
 * The chain's spelling, refused when there is none.
 *
 * A `..` is refused from the RAW spelling, before anything is joined or resolved: `path.resolve` folds one
 * away, and a state path of the form `<link>/..` would then be judged as the directory the link stands in —
 * the walk would create levels, or narrow a mode, at a directory other than the one the caller named, and
 * would tell the caller about a directory it never asked for.
 */
function spelledStateTarget(stateDir: string, names: readonly string[]): string | undefined {
  if (!path.isAbsolute(stateDir)) return undefined;
  const oneName = (name: string): boolean =>
    name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
  if (!names.every(oneName)) return undefined;
  if (hasParentEscape(stateDir)) return undefined;
  return path.join(path.resolve(stateDir), ...names);
}

/**
 * Whether a spelled path names a step back out of the directory it is in, under either separator.
 *
 * `pathComponents` speaks the POSIX separator, because the walk that uses it only runs there; a state path is
 * refused on every host, so this asks the question the way the host's own path does.
 */
function hasParentEscape(spelled: string): boolean {
  return spelled.split(/[\\/]/).some((name) => name === '..');
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
  policy: WalkPolicy,
): WalkGround | Readonly<{ refusedOn: string; exposure: PrivateDirectoryExposure }> {
  try {
    return walkSpelledParent(target, target, trust, create, policy);
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
