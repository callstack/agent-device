import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from './diagnostics.ts';

/**
 * The SHAPE of a path name: cut and joined by ONE platform's rules, with no filesystem in it, so a
 * Windows-shaped path is checked on a macOS host. The walk that judges ground stays host-bound — it `lstat`s
 * real entries — and takes no platform parameter. The helpers below read the host's platform per call, so a
 * test can move it under a caller.
 */
const winHost = () => process.platform === 'win32';

/**
 * `directory` with its trailing separators cut off: the name an entry is looked up under, since a trailing one
 * resolves THROUGH a link at that name. A linear walk, not a regular expression. A root keeps one: `C:` cut
 * from `C:\` is drive-RELATIVE, so the two spellings name other ground.
 */
export function withoutTrailingSeparators(directory: string, windows = winHost()): string {
  const separator = windows ? '\\' : '/';
  let end = directory.length;
  while (end > 0 && (directory[end - 1] === '/' || directory[end - 1] === separator)) end -= 1;
  if (end === 0) return directory.length === 0 ? directory : '/';
  if (windows && directory[end - 1] === ':') return directory.slice(0, end + 1);
  return directory.slice(0, end);
}

/**
 * The name `name` occupies inside `directory`, spelled so it stays WHERE `directory` stands. NOT `path.join`,
 * which normalizes: appending keeps the step in `alias/../state`, `join` answers `state` beside the alias.
 */
export function childPath(directory: string, name: string, windows = winHost()): string {
  const spelled = withoutTrailingSeparators(directory, windows);
  const separator = windows ? '\\' : '/';
  // A root keeps its one separator, so the name is already attached, and so is a name with nothing above it.
  return spelled === '' || spelled.endsWith('/') || spelled.endsWith(separator)
    ? `${spelled}${name}`
    : `${spelled}${separator}${name}`;
}

/** The name `spelled` stands as inside its parent, cut by the same rule that cuts the parent. */
export function childName(spelled: string, windows = winHost()): string {
  return (windows ? path.win32 : path.posix).basename(withoutTrailingSeparators(spelled, windows));
}

/**
 * The directory `directory` stands IN, or `undefined` when nothing stands above it. Asks the platform: Windows
 * reads `/` AND `\` as separators, `C:\state` stands in `C:\`, `\\\\srv\\share` in nothing, `C:` alone is
 * drive-RELATIVE. `dirname` is safe: it cuts one separator without folding a surviving `..`.
 */
export function parentDirectoryPath(directory: string, windows = winHost()): string | undefined {
  const platform = windows ? path.win32 : path.posix;
  const spelled = withoutTrailingSeparators(directory, windows);
  // `dirname('/a//b')` and a share root keep a separator on the end.
  const parent = withoutTrailingSeparators(platform.dirname(spelled), windows);
  // A root is its own parent, and `dirname` answers `.` for a bare name: neither is a base to build under.
  return parent === spelled || parent === '.' ? undefined : parent;
}

/**
 * What this process may rely on when it judges ground: who it is, as the kernel answers. The rule reads no
 * account database, so the answer does not depend on which name services run (ADR 0016).
 *
 * The JUDGMENTS below decide over the fields of one `lstat`, so they are testable on their values: what this
 * process may rely on, whether a directory is safe to publish inside, whether a link belongs to somebody
 * else, and whether another local user could claim the destination's entry.
 */
export type ScriptDestinationTrust = Readonly<{ uid: number }>;

/** What this process may rely on when it judges ground. */
function scriptTrust(): ScriptDestinationTrust {
  return { uid: process.getuid?.() ?? -1 };
}

/**
 * The fields of a directory, or of a link, that the ancestry rule reads, so each decision is testable on the
 * fields of one `lstat` rather than through a filesystem.
 */
export type DirectoryAuthority = Readonly<{ uid: number; mode: number }>;

export type LinkAuthority = Readonly<{ uid: number }>;

/**
 * The ways a step can be unsafe. `unreachable_parent` and `unresolvable_parent` say a walk stopped short with
 * no directory to report; `link_loop_exceeded` says it ran out of hops — refused, never trusted.
 * `untrustedGroundWording` words each one for the caller.
 */
export type ScriptAncestryExposure =
  | 'foreign_owned'
  | 'world_writable'
  | 'shared_group_writable'
  | 'shared_parent'
  | 'planted_link'
  | 'link_loop_exceeded'
  | 'not_a_directory'
  | 'entry_appeared'
  | 'relative_destination'
  | 'unresolvable_parent'
  | 'unreachable_parent'
  | 'parent_replaced';

/**
 * Whether this user can rely on a destination being inside `directory`, and why not if they cannot.
 *
 * Ownership first: a directory another user owns is theirs to chmod or repopulate whatever its mode says
 * today, and no race is needed. Then the mode. A group-writable directory is refused whoever owns the group —
 * proving one holds no other user means reading the host's account files, which ADR 0016 declines to do. The
 * sticky bit is the one mode exception, and sound only for PASSING THROUGH: it cannot refuse a NEW entry by
 * name, so {@link othersCreateEntriesIn} is asked separately before anything is created.
 */
export function untrustedAncestryExposure(
  directory: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): ScriptAncestryExposure | undefined {
  if (directory.uid !== 0 && directory.uid !== trust.uid) return 'foreign_owned';
  if (directory.mode & 0o1000) return undefined;
  if (directory.mode & 0o002) return 'world_writable';
  if (directory.mode & 0o020) return 'shared_group_writable';
  return undefined;
}

/**
 * Whether other local users can add an entry here, which is how the destination's own name, or a directory
 * below it, becomes theirs. A directory somebody else owns counts: they can create, rename or replace any
 * entry in it whatever its mode says, sticky bit included — that bit protects other people's entries.
 */
export function othersCreateEntriesIn(
  directory: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): boolean {
  if (directory.uid !== 0 && directory.uid !== trust.uid) return true;
  if (directory.mode & 0o002) return true;
  return Boolean(directory.mode & 0o020);
}

/**
 * Whether a link on the path is one another local user could have put there, or could replace, and whose
 * target is therefore theirs to choose. Where nobody but this user or root can add entries, a link cannot
 * appear or change behind this rule. Where others CAN, the sticky bit is all that holds an entry in place, so
 * a link this user or root owns stands and one anybody else owns does not. A component stepped back over with
 * `..` is asked as a DIRECTORY: there the caller walks across it rather than publishing through it.
 */
export function untrustedLinkExposure(
  link: LinkAuthority,
  home: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): ScriptAncestryExposure | undefined {
  if (!othersCreateEntriesIn(home, trust)) return undefined;
  if (home.mode & 0o1000 && (link.uid === 0 || link.uid === trust.uid)) return undefined;
  return 'planted_link';
}

export type AtomicPublishMode = 'replace' | 'link-exclusive';

/**
 * Publishes a complete file from a same-directory temporary sibling. Contents are text or bytes: an
 * encoding is passed only for text, so a PNG or a video chunk reaches the disk as the caller built it.
 *
 * The temporary file is always removed. Cleanup is best effort and never replaces the write or publish
 * error; a cleanup failure is retained as secondary evidence when a request diagnostics scope exists.
 */
export function publishFileSync(options: {
  destination: string;
  contents: string | Uint8Array;
  mode?: number;
  preserveExistingMode?: boolean;
  publish?: AtomicPublishMode;
}): void {
  withAtomicPublishTempPathSync(options.destination, (temporaryPath) => {
    const existing = options.preserveExistingMode
      ? fs.statSync(options.destination, { throwIfNoEntry: false })
      : undefined;
    const preservedMode = existing?.isFile() ? existing.mode & 0o777 : undefined;
    const mode = preservedMode ?? options.mode;
    const writeOptions = {
      encoding: typeof options.contents === 'string' ? ('utf8' as const) : undefined,
      ...(mode === undefined ? {} : { mode }),
    };
    fs.writeFileSync(temporaryPath, options.contents, writeOptions);
    if (preservedMode !== undefined) fs.chmodSync(temporaryPath, preservedMode);
    if (options.publish === 'link-exclusive') {
      fs.linkSync(temporaryPath, options.destination);
    } else {
      fs.renameSync(temporaryPath, options.destination);
    }
  });
}

/**
 * Publishes a session script, and nothing else, from a same-directory temporary sibling: `publishFileSync`
 * plus the destination-ancestry rule, asked through {@link prepareScriptDestination}. The chain is judged
 * once here, and the file is private, because a recording is a transcript of what someone did here.
 */
export function publishScriptFileSync(options: {
  destination: string;
  contents: string;
  publish?: AtomicPublishMode;
}): void {
  let temporaryPath: string | undefined;
  try {
    // The temp file is staged in the walk's ANSWER, never beside the spelling: a `..` or a link sends the
    // entry elsewhere, and a temp file where the text points is one another local user can reach.
    const judged = prepareScriptDestination(options.destination).directory;
    temporaryPath = createAtomicPublishTempPath(judged, options.destination);
    fs.writeFileSync(temporaryPath, options.contents, { encoding: 'utf8', mode: SCRIPT_FILE_MODE });
    // A file CREATE ANDs its mode with the umask, so this SAYS the mode on the temporary sibling
    // rather than asking for it, and says it BEFORE the entry exists: no reader ever sees a wider file
    // than {@link SCRIPT_FILE_MODE}. `createMissingLevel` pays the same umask for a directory.
    fs.chmodSync(temporaryPath, SCRIPT_FILE_MODE);
    // The entry is spelled FROM the judged directory, never resolved through the destination again:
    // that second resolution runs against whatever stands on the path by then (ADR 0016).
    const entry = path.join(judged, path.basename(options.destination));
    if (options.publish === 'link-exclusive') {
      fs.linkSync(temporaryPath, entry);
    } else {
      fs.renameSync(temporaryPath, entry);
    }
  } finally {
    removeTempBestEffort(options.destination, temporaryPath);
  }
}

/**
 * The canonical temp path for a destination: a sibling of the name, inside the directory the publish will
 * create the entry in — the walk's answer for a script destination, `path.dirname` for every other one.
 */
function createAtomicPublishTempPath(directory: string, destination: string): string {
  return path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}-${crypto.randomUUID()}.tmp`,
  );
}

function removeTempBestEffort(destination: string, temporaryPath: string | undefined): void {
  if (temporaryPath === undefined) return;
  try {
    fs.rmSync(temporaryPath, { force: true });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'atomic_file_cleanup_failed',
      data: {
        destination,
        temporaryPath,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/** A recording holds literals a `fill` did not parameterize (ADR 0017), so it is written private. */
const SCRIPT_FILE_MODE = 0o600;

/**
 * A directory a publish creates is itself judged on the way to a later version, so it is created at the mode
 * the rule accepts under every umask — the shared-checkout umask 002 would otherwise leave it 0775 and refuse.
 */
const SCRIPT_DIR_MODE = 0o700;

/**
 * Readies a script destination and reports the PHYSICAL directory to create the entry in.
 *
 * One call owns the sequence, because the ORDER is what makes "a refused destination leaves no directories
 * behind" true: the chain is walked, a refusal happens BEFORE anything is created, what is missing is created
 * at {@link SCRIPT_DIR_MODE} inside the judged directory, and the completed chain is walked AGAIN before the
 * answer. Only the second walk asks the CREATION question — whether others could add the destination's own
 * name where the entry lands — because below the first walk the missing directories are this call's own to
 * create at 0700, which keeps `mkdir -p <sticky shared>/recordings` acceptable.
 *
 * On Windows access is an ACL, so the walk is a no-op and the parent is the answer — but the destination
 * still has to be absolute first, on every platform.
 */
export function prepareScriptDestination(destination: string): ScriptDestination {
  const spelled = spelledParent(destination);
  if (process.platform === 'win32') {
    fs.mkdirSync(spelled, { recursive: true, mode: SCRIPT_DIR_MODE });
    return { directory: spelled, identity: publishDirectoryIdentity(spelled) };
  }
  const trust = scriptTrust();
  const walked = walkSpelledParent(spelled, destination, trust);
  if (walked.ended === 'refused') throw walked.reject;
  // A walk that stopped short at an absent name creates that tail inside the directory it judged, and asks
  // the completed chain again. A short walk with a `..` queued behind the absent name creates nothing: no
  // amount of creating resolves a step back out of a directory that is not there.
  if (walked.ended === 'short' && !walked.unresolvable) {
    createMissingLevels(destination, walked.deepest, walked.missing, trust);
    return publishableDestination(
      destination,
      walkSpelledParent(spelled, destination, trust),
      trust,
    );
  }
  return publishableDestination(destination, walked, trust);
}

/**
 * Where a script entry is created: the PHYSICAL directory the rule judged, and that directory's identity as
 * the walk's own `lstat` answered it — what {@link confirmScriptDestination} compares before a rename.
 */
export type ScriptDestination = Readonly<{
  directory: string;
  identity: string | undefined;
}>;

export type DurableFilePublishMode = 'replace' | 'link-exclusive';

/** Publishes complete UTF-8 contents with a durable file and directory fence. */
export function publishDurableFileSync(options: {
  destination: string;
  contents: string;
  mode?: number;
  publish?: DurableFilePublishMode;
}): void {
  const directory = path.dirname(options.destination);
  withAtomicPublishTempPathSync(options.destination, (temporaryPath) => {
    let descriptor: number | undefined;
    let failed = false;
    let primaryError: unknown;
    try {
      assertSafeDestination(options.destination);
      descriptor = fs.openSync(temporaryPath, 'wx', options.mode ?? 0o600);
      fs.writeFileSync(descriptor, options.contents, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      assertSafeDestination(options.destination);
      if (options.publish === 'link-exclusive') {
        fs.linkSync(temporaryPath, options.destination);
      } else {
        fs.renameSync(temporaryPath, options.destination);
      }
      syncDirectoryBestEffort(directory);
    } catch (error) {
      failed = true;
      primaryError = error;
    }
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        if (!failed) {
          failed = true;
          primaryError = error;
        }
      }
    }
    if (failed) throw primaryError;
  });
}

/**
 * Gives a specialized durable publisher a canonical temp path and cleanup
 * ownership while it performs its own open/fsync/safety protocol.
 */
export function withAtomicPublishTempPathSync<T>(
  destination: string,
  publish: (temporaryPath: string) => T,
): T {
  const temporaryPath = createAtomicPublishTempPath(path.dirname(destination), destination);
  try {
    return publish(temporaryPath);
  } finally {
    removeTempBestEffort(destination, temporaryPath);
  }
}

/** Syncs a containing directory where the filesystem supports directory fsync. */
function syncDirectoryBestEffort(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
  }
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

/**
 * Identifies a temp path produced for a particular destination.
 *
 * The temp file is a sibling of the directory the entry is CREATED in, which the spelling need not name
 * (`home/work/../y` with `work` a link), so two spellings are compared as device and inode: `lstat` and
 * `realpathSync` apply a spelled `..` textually and answer the wrong directory.
 */
export function isAtomicPublishTemporaryPath(value: unknown, destination: string): boolean {
  if (typeof value !== 'string') return false;
  const name = path.basename(value);
  if (!name.startsWith(`.${path.basename(destination)}.`) || !name.endsWith('.tmp')) return false;
  return sameDirectory(path.dirname(value), path.dirname(destination));
}

/** Whether two spellings name one directory, by device and inode rather than by path text. */
function sameDirectory(left: string, right: string): boolean {
  if (left === right) return true;
  const here = statOrNull(left);
  const there = statOrNull(right);
  return (
    here !== undefined && there !== undefined && here.dev === there.dev && here.ino === there.ino
  );
}

/** `stat` where any failure is "cannot tell": a temp file nobody can point at is treated as foreign. */
function statOrNull(pathname: string): fs.Stats | undefined {
  try {
    return fs.statSync(pathname);
  } catch {
    return undefined;
  }
}

/**
 * Confirms a destination host-kit ANSWERED earlier, and reports the directory to create the entry in.
 *
 * The one check a caller that stages bytes owes: a download or a long upload can run between the walk that
 * judged the directory and the rename that creates the entry, so the chain is asked again and an ancestor
 * pointed at a link meanwhile is caught. Nothing re-judges ground the walk already owns — the ownership rule
 * is what excludes anyone who could move a judged directory in the first place (ADR 0016).
 */
export function confirmScriptDestination(destination: string, prepared: ScriptDestination): string {
  const current = scriptDestination(destination);
  if (current.identity !== prepared.identity) {
    throw scriptAncestryFailure(destination, current.directory, 'parent_replaced');
  }
  return current.directory;
}

/**
 * Walks a destination that has to stand as it is, creating nothing: refuses unless every directory the
 * kernel looks a name up in is one no other non-root local user can change. {@link prepareScriptDestination}
 * is the same rule for a caller that also needs the tail created. Nothing is created here, so a walk that
 * stopped short at an absent name has no answer and refuses as `unreachable_parent`.
 */
function scriptDestination(destination: string): ScriptDestination {
  const spelled = spelledParent(destination);
  if (process.platform === 'win32') {
    return { directory: spelled, identity: publishDirectoryIdentity(spelled) };
  }
  const trust = scriptTrust();
  const walk = walkSpelledParent(spelled, destination, trust);
  if (walk.ended === 'refused') throw walk.reject;
  return publishableDestination(destination, walk, trust);
}

/**
 * Judges a finished walk and answers where the entry is created, with the identity THIS walk read so a
 * caller that stages bytes can confirm the ground once before its rename. Only an ARRIVED walk has that.
 */
function publishableDestination(
  destination: string,
  walk: WalkOutcome,
  trust: ScriptDestinationTrust,
): ScriptDestination {
  if (walk.ended === 'refused') throw walk.reject;
  if (walk.ended === 'short') {
    throw scriptAncestryFailure(
      destination,
      walk.deepest,
      walk.unresolvable ? 'unresolvable_parent' : 'unreachable_parent',
    );
  }
  // Where other local users can add entries here, one of them can add this entry first and the
  // recording is theirs.
  if (othersCreateEntriesIn(walk.authority, trust)) {
    throw scriptAncestryFailure(destination, walk.deepest, 'shared_parent');
  }
  return { directory: walk.deepest, identity: walk.identity };
}

/**
 * The parent of `destination` exactly as the caller spells it, refusing a RELATIVE destination on EVERY
 * platform, Windows included, where no walk runs to catch it: judging one would put the working directory in
 * the chain, and Node answers that name from a query that can lag a `chdir` (ADR 0016).
 */
function spelledParent(destination: string): string {
  const parent = path.dirname(destination);
  if (!path.isAbsolute(parent)) {
    throw scriptAncestryFailure(destination, parent, 'relative_destination');
  }
  return parent;
}

/** Where the walk stands: a judged directory, the identity its own `lstat` answered, names left to resolve. */
type WalkState = Readonly<{
  deepest: string;
  authority: DirectoryAuthority;
  identity: string;
  /** Path components left to resolve, nearest first. */
  queue: readonly string[];
  /** Link targets expanded so far. */
  hops: number;
}>;

type WalkStep =
  | Readonly<{ kind: 'reject'; path: string; exposure: ScriptAncestryExposure }>
  | Readonly<{
      kind: 'short';
      deepest: string;
      /** The spelled names below the judged directory, the first of them absent. */
      missing: readonly string[];
      /** Whether a `..` is queued behind the name that stopped the walk. */
      behindUpwardStep: boolean;
    }>
  | Readonly<{ kind: 'stand'; state: WalkState }>;

/**
 * Where a walk ended. Only an ARRIVED walk reached the directory the entry is created in, and carries the
 * authority and identity it was judged under, so the caller never asks the host about ground the walk read. A
 * SHORT walk reports the nearest judged directory and the spelled tail below it, which is what a caller that
 * creates needs; `unresolvable` says a `..` is queued behind that tail. A REFUSED walk carries its failure.
 */
type WalkOutcome =
  | Readonly<{
      ended: 'arrived';
      /** The PHYSICAL directory the entry is created in. */
      deepest: string;
      authority: DirectoryAuthority;
      /** That directory's identity, as this walk's `lstat` of it answered. */
      identity: string;
    }>
  | Readonly<{
      ended: 'short';
      /** The nearest directory the walk did judge; the destination's name is absent below it. */
      deepest: string;
      /** The spelled names below `deepest`, the first of them absent. */
      missing: readonly string[];
      /** Whether a `..` is queued behind that name, so creating cannot resolve the chain. */
      unresolvable: boolean;
    }>
  | Readonly<{
      ended: 'refused';
      /** The step the walk could not stand on, and the way it is unsafe. */
      ancestor: string;
      exposure: ScriptAncestryExposure;
      /** The same judgment, worded for a caller that is saving a script. */
      reject: AppError;
    }>;

/**
 * Judges the ground `directory` STANDS ON and answers the PHYSICAL directory the walk arrived on, by asking
 * what a name INSIDE it would resolve to. Nothing is created: the probe name is never looked up.
 *
 * A caller that CHANGES anything below `directory` has to ask this first: `O_NOFOLLOW` guards only the LAST
 * name of an open, and the answer is the only name further levels may be built from, because a spelled path
 * is NOT the chain the kernel walks (ADR 0016).
 *
 * Trusted: `{ physical }`, no trailing separator. Untrusted: the step it could not stand on and why.
 */
export function verifiedDirectoryAncestry(
  directory: string,
):
  | Readonly<{ physical: string }>
  | Readonly<{ ancestor: string; exposure: ScriptAncestryExposure }> {
  const ground = verifiedDirectoryGround(directory);
  // STOPPED SHORT has no directory to vouch for here, which a caller that only reads has to be told about.
  if (ground.ended === 'short')
    return {
      ancestor: ground.established,
      exposure: ground.unresolvable ? 'unresolvable_parent' : 'unreachable_parent',
    };
  return ground.ended === 'arrived'
    ? { physical: ground.physical }
    : { ancestor: ground.ancestor, exposure: ground.exposure };
}

/**
 * What the walk answers about `directory` itself, in the three shapes it can end in: the physical directory it
 * arrived on, the names it found ABSENT below the deepest directory it judged, or the step it could not stand
 * on. {@link verifiedDirectoryAncestry} collapses the middle shape into a refusal, right for a caller that only
 * reads. A caller that CREATES has to tell them apart, because that decides whether creating is safe: `short`
 * with no `unresolvable` step behind it is the ONE case creation may proceed in, and {@link createStateLevels}
 * makes each missing name inside the judged directory so a link cannot carry the creation to its far side.
 */
export function verifiedDirectoryGround(directory: string): DirectoryGround {
  if (!path.isAbsolute(directory))
    return { ended: 'refused', ancestor: directory, exposure: 'relative_destination' };
  const spelled = withoutTrailingSeparators(directory);
  // Windows access is an ACL, so there is no chain to walk and the shaped name is the answer.
  if (process.platform === 'win32') return { ended: 'arrived', physical: spelled };
  const walked = walkSpelledParent(spelled, `${spelled}/${CHAIN_PROBE_NAME}`, scriptTrust());
  if (walked.ended === 'refused')
    return { ended: 'refused', ancestor: walked.ancestor, exposure: walked.exposure };
  if (walked.ended === 'arrived') return { ended: 'arrived', physical: walked.deepest };
  return {
    ended: 'short',
    established: walked.deepest,
    missing: walked.missing,
    unresolvable: walked.unresolvable,
  };
}

/** The three endings {@link verifiedDirectoryGround} answers with. */
export type DirectoryGround =
  | Readonly<{ ended: 'arrived'; physical: string }>
  | Readonly<{
      ended: 'short';
      /** The deepest directory the walk judged; every name of `missing` is below it and absent. */
      established: string;
      missing: readonly string[];
      /** A `..` is queued behind an absent name, so no amount of creating resolves the chain. */
      unresolvable: boolean;
    }>
  | Readonly<{ ended: 'refused'; ancestor: string; exposure: ScriptAncestryExposure }>;

/**
 * Resolves `directory` ONCE to the physical path the kernel takes to it, judging the ancestry above it, and
 * answers the name every path below it has to be built from. The last component is CUT and re-attached, never
 * normalized: `alias/../state` is not `/state`, and `state/` resolves THROUGH a link at `state` (ADR 0016).
 *
 * Everything here is the HOST's: the shape is read with the host's separator and the judgment `lstat`es real
 * entries, so no platform selection is offered. On a Windows host the walk is a no-op and this answers the
 * host-shaped name.
 */
export function verifiedDirectoryPath(
  directory: string,
):
  | Readonly<{ physical: string }>
  | Readonly<{ ancestor: string; exposure: ScriptAncestryExposure }> {
  const spelled = withoutTrailingSeparators(directory);
  // CUT at BOTH ends by the host's rule. Slicing at `dirname`'s length spends the name's first character when
  // its parent is a root: `/state` answered `//tate`, and every real child of a root was then refused.
  const name = childName(spelled);
  const parent = parentDirectoryPath(spelled);
  // Nothing above it to walk: judging `state` would put the working directory in the chain.
  if (parent === undefined || name === '')
    return { ancestor: directory, exposure: 'relative_destination' };
  const judged = verifiedDirectoryAncestry(parent);
  if (!('physical' in judged)) return judged;
  return { physical: childPath(judged.physical, name) };
}

/**
 * Judges ground, then creates ONLY what is missing, by the same per-level rule a script destination is created
 * by. A caller that owns a state chain asks this rather than `mkdir -p`: a recursive creation resolves the whole
 * tail as TEXT, so a link at a missing name carries the creation to its far side, where as root it creates with
 * privileges. {@link createMissingLevel} is the ONE creator here: `established` is ground already judged to be
 * this caller's to build under, `missing` the spelled tail below it. A step that cannot be stood on is refused
 * and nothing below it is created, so a refusal leaves no directory behind.
 */
export function createStateLevels(
  subject: string,
  established: string,
  missing: readonly string[],
): void {
  createMissingLevels(subject, established, missing, scriptTrust());
}

/** The name {@link verifiedDirectoryAncestry} asks the walk about; it is never created. */
const CHAIN_PROBE_NAME = '.agent-device-ancestry-probe';

/**
 * Walks the spelled parent exactly as the kernel resolves a path, judging every step, and refuses at the first
 * one another local user could steer. The directory it reports is where the entry gets created.
 *
 * No `realpath`: it answers only with the FINAL directory, so every level stepped through can vanish from the
 * judgment when a link leads to another link. Each component is resolved against the directory PHYSICALLY
 * reached — `.` skipped, `..` applied to that directory's parent, a link's RAW components queued ahead of the
 * rest (ADR 0016). Hops are capped at {@link MAX_SCRIPT_PATH_LINK_HOPS}; running out is a refusal.
 * `destination` appears only in the refusal that names it.
 */
function walkSpelledParent(
  parent: string,
  destination: string,
  trust: ScriptDestinationTrust,
): WalkOutcome {
  let step = startWalk(parent, trust);
  // Every step consumes a component, and every link hop counts against a fixed limit, so this ends.
  for (;;) {
    if (step.kind === 'reject') {
      return {
        ended: 'refused',
        ancestor: step.path,
        exposure: step.exposure,
        reject: scriptAncestryFailure(destination, step.path, step.exposure),
      };
    }
    if (step.kind === 'short') {
      return {
        ended: 'short',
        deepest: step.deepest,
        missing: step.missing,
        unresolvable: step.behindUpwardStep,
      };
    }
    const { state } = step;
    const [component, ...rest] = state.queue;
    // The only ending that ARRIVES: an empty queue, every name the parent spelled resolved and judged.
    if (component === undefined) {
      return {
        ended: 'arrived',
        deepest: state.deepest,
        authority: state.authority,
        identity: state.identity,
      };
    }
    step = stepThrough(state, component, rest, trust);
  }
}

/** The first state: the root, every component of the parent still to resolve. */
function startWalk(parent: string, trust: ScriptDestinationTrust): WalkStep {
  return standOn('/', pathComponents(parent), trust, 0);
}

/**
 * Stands the walk on `directory`, judged from this call's own `lstat` of it, or refuses it.
 *
 * A name come back around through a `..` or an alias is judged again from a fresh `lstat`, and reaches the
 * judgment it had on the first visit: the rule keeps no memory of ground it already owned, because standing
 * here already means others cannot write in it, or it is sticky (ADR 0016).
 */
function standOn(
  directory: string,
  queue: readonly string[],
  trust: ScriptDestinationTrust,
  hops: number,
): WalkStep {
  const stats = lstatEntry(directory);
  if (stats === undefined || !stats.isDirectory()) {
    return { kind: 'reject', path: directory, exposure: 'not_a_directory' };
  }
  const authority = directoryAuthority(stats);
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) return { kind: 'reject', path: directory, exposure };
  return {
    kind: 'stand',
    state: { deepest: directory, authority, identity: identityOf(stats), queue, hops },
  };
}

/** Owner and mode of the ENTRY one `lstat` answer describes. */
function directoryAuthority(stats: fs.BigIntStats): DirectoryAuthority {
  return { uid: Number(stats.uid), mode: Number(stats.mode) };
}

/**
 * The device and inode an `lstat` answer names. BIGINT stats: a numeric `ino` cannot hold every inode a
 * filesystem hands out, so two distinct large inodes would collapse onto one identity.
 */
function identityOf(stats: fs.BigIntStats): string {
  return `${stats.dev}:${stats.ino}`;
}

/** The only lookup this rule makes: `lstat` with bigint ids, absence as `undefined`. */
function lstatEntry(pathname: string): fs.BigIntStats | undefined {
  return fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
}

/** The names of `directory`, every `.` resolved away the way the kernel does. */
function pathComponents(directory: string): string[] {
  return directory.split('/').filter((component) => component.length > 0 && component !== '.');
}

/** Advances one component of the queue, which the caller knows to be non-empty. */
function stepThrough(
  state: WalkState,
  component: string,
  rest: readonly string[],
  trust: ScriptDestinationTrust,
): WalkStep {
  // `..` is the parent of the directory PHYSICALLY stood in, not of the spelling: where `work` is a link,
  // `.../work/../x` steps back from the link's target and lands beside it.
  if (component === '..') {
    return standOn(path.dirname(state.deepest), rest, trust, state.hops);
  }
  return stepIntoEntry(state, component, rest, trust);
}

/** Resolves one named entry inside the directory the walk stands in. */
function stepIntoEntry(
  state: WalkState,
  component: string,
  rest: readonly string[],
  trust: ScriptDestinationTrust,
): WalkStep {
  const entry = path.join(state.deepest, component);
  const stats = lstatEntry(entry);
  // Nothing below here exists yet, so the walk stops at the ground it judged and reports the tail under
  // it: a caller that creates makes that tail, a caller that creates nothing refuses.
  if (stats === undefined) {
    return {
      kind: 'short',
      deepest: state.deepest,
      missing: [component, ...rest],
      behindUpwardStep: rest.includes('..'),
    };
  }
  // This lstat IS the judgment: type, owner and mode of the ENTRY the name holds. `stat` would answer
  // whatever stands there by then — on a race, a link somebody else put there.
  if (stats.isSymbolicLink()) return stepThroughLink(state, entry, stats, rest, trust);
  if (!stats.isDirectory()) return { kind: 'reject', path: entry, exposure: 'not_a_directory' };
  const authority = directoryAuthority(stats);
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) return { kind: 'reject', path: entry, exposure };
  return {
    kind: 'stand',
    state: {
      deepest: entry,
      authority,
      identity: identityOf(stats),
      queue: rest,
      hops: state.hops,
    },
  };
}

/** One hop: the link is judged where it stands, and its target's components enter the queue. */
function stepThroughLink(
  state: WalkState,
  link: string,
  stats: fs.BigIntStats,
  rest: readonly string[],
  trust: ScriptDestinationTrust,
): WalkStep {
  const exposure = untrustedLinkExposure({ uid: Number(stats.uid) }, state.authority, trust);
  if (exposure) return { kind: 'reject', path: link, exposure };
  if (state.hops >= MAX_SCRIPT_PATH_LINK_HOPS) {
    return { kind: 'reject', path: link, exposure: 'link_loop_exceeded' };
  }
  const target = fs.readlinkSync(link);
  // A relative target continues from the directory that HOLDS the link, and its components are queued
  // RAW: `path.join` would fold a `..` inside the target away, the one simplification this walk may not
  // make, because the kernel applies that `..` to the physical directory it reaches after them.
  const home = path.isAbsolute(target) ? '/' : path.dirname(link);
  return standOn(home, [...pathComponents(target), ...rest], trust, state.hops + 1);
}

/**
 * How many link targets one walk expands before it refuses, kept BELOW the smallest limit the supported
 * kernels apply (macOS 32, Linux 40) so this rule reaches its own limit first and answers with its own reason.
 */
export const MAX_SCRIPT_PATH_LINK_HOPS = 30;

/** One directory's identity, so a route that runs no walk on Windows can still answer with one. */
function publishDirectoryIdentity(directory: string): string | undefined {
  if (process.platform === 'win32') return 'windows';
  const stats = lstatEntry(directory);
  return stats ? identityOf(stats) : undefined;
}

/** Why each exposure makes that ground unsafe, in the caller's terms. */
const untrustedGroundWording: Record<ScriptAncestryExposure, string> = {
  foreign_owned: 'another local user owns that part of the path.',
  world_writable: 'any local user can write that part of the path.',
  shared_group_writable:
    'the group can write that part of the path, and agent-device cannot tell who else belongs to that group.',
  shared_parent: 'another local user could create the script file there first.',
  planted_link: 'another local user could have put that symbolic link there, or could replace it.',
  link_loop_exceeded:
    'that part of the path follows more symbolic links than the system allows, so where the script would land is not established.',
  not_a_directory: 'a directory was expected there, and something else stands in the way.',
  entry_appeared:
    'a directory the script path needs was missing when the path was checked and appeared before this save could create it.',
  relative_destination:
    'the script path has to be absolute, so the directories it names are the ones that get checked.',
  unresolvable_parent:
    'the script path names a directory that does not exist and steps back out of it with `..`, so where the script would land is not established.',
  unreachable_parent:
    'the directory the script path names does not exist, so the script has nowhere to be written.',
  parent_replaced: '',
};

/**
 * The typed reasons a destination-ancestry refusal answers with, named here rather than spelled again by
 * whoever reads them.
 */
const SCRIPT_ANCESTRY_REASONS = ['script_ancestor_untrusted', 'script_ancestry_replaced'] as const;

/** A reason this rule answers with, or `undefined` for an error that came from somewhere else. */
export function scriptAncestryReason(error: unknown): string | undefined {
  if (!(error instanceof AppError)) return undefined;
  const reason = error.details?.reason;
  return typeof reason === 'string' &&
    (SCRIPT_ANCESTRY_REASONS as readonly string[]).includes(reason)
    ? reason
    : undefined;
}

function scriptAncestryFailure(
  destination: string,
  ancestor: string,
  exposure: ScriptAncestryExposure,
): AppError {
  const replaced = exposure === 'parent_replaced';
  const wording = untrustedGroundWording[exposure];
  return new AppError(
    'COMMAND_FAILED',
    replaced
      ? `The directory for ${destination} changed while the script was staged, so the script was not saved.`
      : `Refusing to save the script under ${ancestor}: ${wording}`,
    {
      reason: replaced ? SCRIPT_ANCESTRY_REASONS[1] : SCRIPT_ANCESTRY_REASONS[0],
      exposure,
      path: destination,
      ancestor,
      hint: ancestryHint(exposure, ancestor),
    },
  );
}

/** What to do about it. A group-writable directory is the one refusal the caller can fix in place. */
function ancestryHint(exposure: ScriptAncestryExposure, ancestor: string): string {
  if (exposure === 'parent_replaced') {
    return 'Re-record with open --save-script, or save under a directory nobody else can write.';
  }
  if (exposure === 'shared_group_writable') {
    return `Close the directory to its group with \`chmod g-w ${ancestor}\`, or save the script under a directory only you can write.`;
  }
  return 'Save the script under a directory you own that only you can write, and keep the path out of directories other users own.';
}

/**
 * Creates the tail the walk found missing, ONE LEVEL AT A TIME, inside the directory the walk judged. A
 * recursive `mkdir` cannot be used here even though it takes a mode (see {@link createStateLevels}).
 *
 * A name absent when the walk looked but present by the time `mkdir` reaches it is JUDGED, not refused and not
 * trusted: two processes saving into the same new directory meet here. It is read by the same single `lstat`
 * every other step is, and a level that passes becomes the directory the next name is created in, so creation
 * never follows a name the rule did not take.
 */
function createMissingLevels(
  destination: string,
  established: string,
  missing: readonly string[],
  trust: ScriptDestinationTrust,
): void {
  let parent = established;
  for (const name of missing) {
    parent = createMissingLevel(destination, parent, name, trust);
  }
}

/**
 * Creates one missing level inside `parent`, or adopts the entry that appeared in its place, and reports the
 * directory the next name is created in.
 */
function createMissingLevel(
  destination: string,
  parent: string,
  name: string,
  trust: ScriptDestinationTrust,
): string {
  const level = path.join(parent, name);
  let created = true;
  try {
    fs.mkdirSync(level, { mode: SCRIPT_DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    created = false;
  }
  // The `lstat` of the NAME, after the creation attempt, is the judgment either way: what this call made
  // and what arrived beside it are read the same way and judged by the same rule.
  const seen = lstatEntry(level);
  if (seen === undefined || !seen.isDirectory()) {
    throw scriptAncestryFailure(destination, level, created ? 'not_a_directory' : 'entry_appeared');
  }
  const authority = directoryAuthority(seen);
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) throw scriptAncestryFailure(destination, level, exposure);
  if (created) {
    // `mkdir` ANDs its mode with the umask, and a umask can take an OWNER bit away: umask 200 would leave
    // this level 0500, where this call could not create the name below it. One `chmod` makes the level the
    // mode this rule creates, whatever the host's umask is.
    fs.chmodSync(level, SCRIPT_DIR_MODE);
    return level;
  }
  // Somebody else's directory: the one place this rule asks whether OTHER users could add a name here.
  if (othersCreateEntriesIn(authority, trust)) {
    throw scriptAncestryFailure(destination, level, 'shared_parent');
  }
  return level;
}

function assertSafeDestination(destination: string): void {
  const stats = lstatIfPresent(destination);
  if (stats?.isSymbolicLink()) {
    throw new Error(`Refusing to replace a durable file symbolic link: ${destination}`);
  }
  if (stats && !stats.isFile()) {
    throw new Error(
      `Refusing to replace a durable path that is not a regular file: ${destination}`,
    );
  }
}
