import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from './diagnostics.ts';

export type AtomicPublishMode = 'replace' | 'link-exclusive';

/**
 * Publishes a complete file from a same-directory temporary sibling.
 *
 * Contents are either UTF-8 text or bytes: an encoding is only ever passed when the caller handed
 * over text, so a PNG or a video chunk reaches the disk exactly as the caller built it.
 *
 * The temporary file is always removed after the publish attempt. Cleanup is
 * best effort and never replaces the write or publish error; when a request
 * diagnostics scope exists, a cleanup failure is retained as secondary evidence.
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
 * Publishes a session script, and nothing else, from a same-directory temporary sibling.
 *
 * This is `publishFileSync` plus the destination-ancestry rule (#4565): the chain is refused before
 * anything is staged and judged again before the link or rename. The file is private, because a recording
 * is a transcript of what someone did on this machine.
 *
 * `parentIdentity` is what {@link publishDirectoryIdentity} returned for a parent the caller created or
 * checked before it staged this file.
 */
export function publishScriptFileSync(options: {
  destination: string;
  contents: string;
  publish?: AtomicPublishMode;
}): void {
  // The directory the entry is created in is the walk's ANSWER, asked for twice inside this call and
  // never `path.dirname` of the spelling: a `..` or a link sends the entry elsewhere, and a temp file
  // staged where the text points is one another local user can reach and put their bytes behind.
  let temporaryPath: string | undefined;
  try {
    const judged = assertPrivateScriptDestination(options.destination);
    const expected = publishDirectoryIdentity(judged);
    temporaryPath = createAtomicPublishTempPath(judged, options.destination);
    fs.writeFileSync(temporaryPath, options.contents, { encoding: 'utf8', mode: SCRIPT_FILE_MODE });
    const stillJudged = assertPrivateScriptDestination(options.destination, expected);
    if (stillJudged !== judged) {
      throw scriptAncestryFailure(options.destination, stillJudged, 'parent_replaced');
    }
    // The entry is created in the directory the walk ANSWERED, spelled from it, never through the
    // destination's own spelling: the kernel would resolve that a second time, against whatever stands on
    // the path by then, and land the entry in ground the rule never reached.
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

/** Syncs a containing directory when the host filesystem supports directory fsync. */
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

/**
 * `lstat` that treats absence as `undefined`; every other errno propagates.
 *
 * Owned here, not in a module of its own, because the publish rule sits on the daemon's startup path: a
 * new module on that edge is eager code every entry that publishes a file pays for today (ADR 0019). The
 * verified-file guards ask the same question, and this module is on their path already.
 */
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
 * The temp file is a sibling of the directory the entry is CREATED in, which is not the directory the
 * destination's spelling names: `home/work/../y` with `work` a link names `home/y` as text, while the
 * entry lands beside the link's target. The two are therefore compared as device and inode, because
 * `lstat` or `realpathSync` applies a spelled `..` textually and answers the wrong directory — which
 * rejects the real temp sibling and accepts a look-alike planted beside the directory the text names.
 */
export function isAtomicPublishTemporaryPath(value: unknown, destination: string): boolean {
  if (typeof value !== 'string') return false;
  const name = path.basename(value);
  if (!name.startsWith(`.${path.basename(destination)}.`) || !name.endsWith('.tmp')) return false;
  return sameDirectory(path.dirname(value), path.dirname(destination));
}

/** Whether two directory spellings name one directory, by device and inode rather than by path text. */
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
 * Refuses a script destination unless every directory the kernel looks a name up in is one no other
 * non-root local user can change (#4565), and reports the PHYSICAL directory the entry is created in.
 *
 * Node exposes no `openat` or `renameat`, so a publisher cannot resolve a destination relative to a
 * directory handle. The window is closed by PERMISSIONS instead of by timing: once no other non-root
 * user can add or remove an entry in any directory on the walk, nobody can swap a component out or plant
 * one, so the path this rule judged is the path the publish reaches. Nothing here depends on when a
 * directory was judged, and no re-check is what makes the write safe.
 *
 * The return value is part of the rule, not a convenience: the caller stages the temp file IN THAT
 * DIRECTORY, because a `..` or a link means the entry lands somewhere `path.dirname` does not name, and
 * staging outside the judged directory hands another local user the temp file that gets published.
 *
 * What it asks of every directory it enters is {@link untrustedAncestryExposure}: ownership first, then
 * the mode, with the sticky bit excusing only passing THROUGH. {@link othersCreateEntriesIn} is asked
 * separately of the directory the walk ended in, because that bit cannot refuse a NEW entry by name, and
 * every followed link is judged by {@link untrustedLinkExposure} against the directory that holds it.
 * A group-writable directory stays acceptable when its group is this user's own private group, the shape
 * Ubuntu and Debian give home directories; {@link privateGroupId} says what that takes to establish.
 *
 * A component that is neither a directory nor a link is refused as `not_a_directory`: the kernel cannot
 * travel through it either. On Windows access is an ACL, so this rule is a no-op and answers the parent
 * it was given.
 *
 * `parentIdentity` is what {@link publishDirectoryIdentity} returned for the parent the caller created
 * or checked before it staged this file. The rule above already excludes anyone who could swap it, so the
 * comparison is defense in depth against a host whose modes moved meanwhile, not what closes the window.
 */
export function assertPrivateScriptDestination(
  destination: string,
  parentIdentity?: string,
): string {
  if (process.platform === 'win32') return path.dirname(path.resolve(destination));
  const trust = readScriptTrust();
  const walk = walkParent(destination, trust);
  if (walk.reject !== undefined) throw walk.reject;
  if (walk.unresolvable) {
    throw scriptAncestryFailure(destination, walk.deepest, 'unresolvable_parent');
  }
  if (!walk.arrived) {
    // The walk stopped at a name that does not exist. A publisher that creates no directories has
    // nowhere to write, and writing the entry into the nearest ancestor instead would publish it under
    // a name the caller never gave it.
    throw scriptAncestryFailure(destination, walk.deepest, 'unreachable_parent');
  }
  // The identity is asked of the directory the entry is created in, which is the walk's answer and NOT
  // `path.dirname` of the spelling: where a `..` or a link leads elsewhere, the spelled parent is a
  // different directory and comparing against it reports a replacement that never happened.
  if (parentIdentity !== undefined && publishDirectoryIdentity(walk.deepest) !== parentIdentity) {
    throw scriptAncestryFailure(destination, walk.deepest, 'parent_replaced');
  }
  // The script entry is created inside the deepest directory the walk reached, or below it through
  // directories that do not exist yet. Where other local users can add entries, one of them can add
  // this entry first and the recording is theirs, so the creation has to be refused. The authority the
  // walk read there is reused rather than read again.
  if (walk.authority !== undefined && othersCreateEntriesIn(walk.authority, trust)) {
    throw scriptAncestryFailure(destination, walk.deepest, 'shared_parent');
  }
  return walk.deepest;
}

/**
 * Refuses a script destination before its caller creates anything on the way to it, answering whether
 * the caller's `mkdir` may run. Callers that create a missing parent run this first, then create, then
 * run {@link assertPrivateScriptDestination} once the directory the entry lands in exists.
 *
 * It is the same walk, not a second rule: it stops at the first component that does not exist, so asking
 * it before the `mkdir` judges exactly the prefix that is already there. Two questions the full rule asks
 * are deliberately NOT asked here: the creation question — others adding a name inside the directory the
 * walk ends in — because the directories below are the caller's own to create, at its own mode, which is
 * what keeps `mkdir -p <sticky shared>/recordings` acceptable; and the arrival question, because the
 * missing tail is what the `mkdir` is for.
 *
 * A `..` queued BEHIND the absent component stops the `mkdir` anyway. The kernel cannot apply that step
 * until the name before it exists, while a recursive `mkdir` resolves the spelling as text and builds
 * what stands on the far side of it: `private/missing/../../shared/recordings` never gets `shared`
 * judged, and the `mkdir` creates `<root>/shared/recordings` where any local user can write. A `..` over
 * directories that all exist resolves for the walk as the kernel resolves it, and stays fine.
 *
 * The refusal is the same typed error the full rule raises, so a caller sees one reason for one shape of
 * path whichever of the two asked it.
 */
export function assertPrivateScriptDestinationPrefix(destination: string): void {
  if (process.platform === 'win32') return;
  const walk = walkParent(destination, readScriptTrust());
  if (walk.reject !== undefined) throw walk.reject;
  if (walk.unresolvable) {
    throw scriptAncestryFailure(destination, walk.deepest, 'unresolvable_parent');
  }
}

/**
 * The parent of `destination` as a chain of components from the root, never normalized: `path.resolve`
 * folds a `..` away, which is the one simplification this may not make, because the kernel does not make
 * it either — `.../work/../x` lands its entry beside the target of the link named `work`.
 *
 * A RELATIVE destination is resolved against the working directory, but not made absolute by joining the
 * two: the cwd's OWN components are queued first and the destination's follow them raw. Standing the walk
 * in the cwd would judge the cwd and nothing above it, and a caller who cannot write `/shared` can still
 * swap the `/shared/mine` the cwd names. That name is first confirmed to be where the process really
 * stands ({@link standsIn}), because it is the name the walk queues.
 */
function absoluteParent(destination: string): WalkStart {
  const parent = path.dirname(destination);
  if (path.isAbsolute(parent)) return { pathname: parent };
  // `path.resolve('')` is the working directory; its components and the destination's own parent, in
  // order, are what the walk has to walk. `path.resolve(destination)` must NOT be used: it folds.
  const cwd = path.resolve('');
  if (!standsIn(cwd)) return { reject: { path: cwd, exposure: 'parent_replaced' } };
  return { pathname: `${cwd}/${parent === '.' ? '' : parent}` };
}

/** The spelling to start a walk from, or the refusal that stops it before the first component. */
type WalkStart =
  | Readonly<{ pathname: string; reject?: undefined }>
  | Readonly<{
      reject: Readonly<{ path: string; exposure: ScriptAncestryExposure }>;
      pathname?: undefined;
    }>;

/**
 * Whether the process really stands in the directory `pathname` names as its working directory.
 *
 * Node answers the working directory from the last `chdir` it made, so its NAME can go stale: move the
 * directory it points at and put another at that path, and a walk of the name judges the replacement
 * while the kernel resolves every relative name in the moved one. The two are therefore compared as
 * device and inode, the one answer that makes both names mean one directory.
 */
function standsIn(pathname: string): boolean {
  const remembered = statOrNull(pathname);
  const standing = statOrNull('.');
  return (
    remembered !== undefined &&
    standing !== undefined &&
    remembered.dev === standing.dev &&
    remembered.ino === standing.ino
  );
}

/**
 * Where the walk stands: a directory it judged and physically reached, plus the names still to resolve.
 */
type WalkState = Readonly<{
  deepest: string;
  authority: DirectoryAuthority;
  /** Path components left to resolve, nearest first. */
  queue: readonly string[];
  /** Link targets expanded so far. */
  hops: number;
  /** What this walk already learned about the ground it stands on. */
  ground: WalkGround;
}>;

/**
 * One walk's memory of the ground it stood on: the `stat` of every path it read, keyed by that path. A
 * path that comes back around, through a `..` or an alias, is asked once, so one walk sees the host the
 * same way throughout.
 */
type WalkGround = Readonly<{
  stats: Map<string, fs.Stats>;
}>;

type WalkStep =
  | Readonly<{ kind: 'reject'; path: string; exposure: ScriptAncestryExposure }>
  | Readonly<{
      kind: 'short';
      deepest: string;
      authority: DirectoryAuthority;
      /** Whether a `..` is queued behind the name that stopped the walk. */
      behindUpwardStep: boolean;
    }>
  | Readonly<{ kind: 'stand'; state: WalkState }>;

/**
 * A walk that ended: the typed refusal, or the directory the entry is created in together with the
 * authority it was judged with. The authority travels with the answer, so the caller never asks the host
 * about ground the walk has already read.
 *
 * `arrived` says the resolution reached the directory the entry is created in. Otherwise the walk stopped
 * at a name that does not exist and reports the nearest ancestor it did reach, which is NOT where the
 * entry belongs: publishing there writes a file the caller never named.
 *
 * `unresolvable` says a `..` is queued behind that absent name, so creating cannot finish the resolution:
 * the step up depends on a directory that is not there to be looked up in, and the caller's `mkdir`
 * resolves the same spelling as text and lands somewhere else.
 */
type WalkOutcome = Readonly<{
  reject: AppError | undefined;
  deepest: string;
  authority: DirectoryAuthority | undefined;
  arrived: boolean;
  unresolvable: boolean;
}>;

/**
 * Walks the spelled parent exactly as the kernel resolves a path, judging every step, and refuses at the
 * first step another local user could steer. The directory it reports is where the entry gets created.
 *
 * No `realpath` is involved anywhere: `realpathSync` answers only with the FINAL directory, so every
 * directory stepped through can vanish from the answer, and from the judgment, whenever a link leads on
 * to another link. Each component is resolved against the directory physically reached instead:
 *
 * - `.` is skipped; `..` moves to the parent of the directory physically stood in, which is judged like
 *   any other directory. Neither one is a name that has to exist.
 * - Any other component is lstat'ed in that directory. An absent one ENDS the walk at the nearest
 *   directory the walk did reach, and the outcome says so: `arrived` is false, and `unresolvable` is true
 *   when a `..` is queued behind that name.
 * - A directory is judged and entered. Each path is read from the host once per walk, so a `..` back over
 *   ground already crossed, or an alias of it, does not ask the host again.
 * - A symbolic link is judged itself, against the directory that physically holds it, and its target's
 *   RAW components go in front of the queue — restarting from `/` for an absolute target, continuing from
 *   the link's own directory for a relative one. Hops are counted against
 *   {@link MAX_SCRIPT_PATH_LINK_HOPS}, and crossing it is refused rather than trusted.
 * - A component that is neither a directory nor a link cannot carry a publish, and is refused.
 *
 * A relative destination is walked from the root too, over the working directory's components first: the
 * caller stands in that directory, but it is still a name in its parent, and the parent is judged too.
 */
function walkParent(destination: string, trust: ScriptDestinationTrust): WalkOutcome {
  const start = absoluteParent(destination);
  if (start.reject !== undefined) {
    return refused(refusalAt(destination, start.reject));
  }
  let step = startWalk(start.pathname, trust);
  // Every step consumes a component, and every link hop counts against a fixed limit, so this ends.
  for (;;) {
    if (step.kind === 'reject') return refused(refusalAt(destination, step));
    if (step.kind === 'short') {
      return {
        reject: undefined,
        deepest: step.deepest,
        authority: step.authority,
        arrived: false,
        unresolvable: step.behindUpwardStep,
      };
    }
    const { state } = step;
    const [component, ...rest] = state.queue;
    if (component === undefined) {
      // The one way a walk ARRIVES: every name the parent spelled has been resolved and judged.
      return {
        reject: undefined,
        deepest: state.deepest,
        authority: state.authority,
        arrived: true,
        unresolvable: false,
      };
    }
    step = stepThrough(state, component, rest, trust);
  }
}

/** A walk that refused has no directory to report, because none of them is established as the entry's. */
function refused(reject: AppError): WalkOutcome {
  return { reject, deepest: '/', authority: undefined, arrived: false, unresolvable: false };
}

function refusalAt(
  destination: string,
  step: Readonly<{ path: string; exposure: ScriptAncestryExposure }>,
): AppError {
  return scriptAncestryFailure(destination, step.path, step.exposure);
}

/** The first state: the root, with every component of the parent still to resolve. */
function startWalk(parent: string, trust: ScriptDestinationTrust): WalkStep {
  const queue = pathComponents(parent);
  const ground: WalkGround = { stats: new Map() };
  return standIn('/', queue, trust, 0, ground);
}

/** Judges `directory` and stands the walk there, or refuses it. */
function standIn(
  directory: string,
  queue: readonly string[],
  trust: ScriptDestinationTrust,
  hops: number,
  ground: WalkGround,
): WalkStep {
  const stats = readGround(ground, directory);
  if (stats === undefined) return { kind: 'reject', path: directory, exposure: 'not_a_directory' };
  const authority: DirectoryAuthority = { uid: stats.uid, gid: stats.gid, mode: stats.mode };
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) return { kind: 'reject', path: directory, exposure };
  return { kind: 'stand', state: { deepest: directory, authority, queue, hops, ground } };
}

/** The `stat` of a directory this walk stands in, read from the host at most once per path. */
function readGround(ground: WalkGround, directory: string): fs.Stats | undefined {
  const known = ground.stats.get(directory);
  if (known !== undefined) return known;
  const stats = statDirectoryChain(directory);
  if (stats !== undefined) ground.stats.set(directory, stats);
  return stats;
}

/** The names of `directory`, with every `.` resolved away the way the kernel resolves it. */
function pathComponents(directory: string): string[] {
  return directory.split('/').filter((component) => component.length > 0 && component !== '.');
}

/**
 * Advances one component of the queue, which the caller knows to be non-empty: an empty queue is where a
 * walk arrives, and {@link walkParent} answers that itself.
 */
function stepThrough(
  state: WalkState,
  component: string,
  rest: readonly string[],
  trust: ScriptDestinationTrust,
): WalkStep {
  // `..` is the parent of the directory PHYSICALLY stood in, not of the spelling: where `work` is a link,
  // `.../work/../x` steps back from the link's target and lands beside it.
  if (component === '..') {
    return standIn(path.dirname(state.deepest), rest, trust, state.hops, state.ground);
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
  const stats = lstatIfPresent(entry);
  // Nothing below here exists yet: a caller that creates missing parents stops here and creates inside
  // the directory the walk reached; a publisher that creates nothing refuses. Neither may go on as if the
  // name had resolved.
  if (stats === undefined) {
    return {
      kind: 'short',
      deepest: state.deepest,
      authority: state.authority,
      behindUpwardStep: rest.includes('..'),
    };
  }
  if (stats.isSymbolicLink()) return stepThroughLink(state, entry, stats, rest, trust);
  return standIn(entry, rest, trust, state.hops, state.ground);
}

/**
 * One hop. The link is judged where it physically stands, and its target's components enter the queue,
 * because the kernel steps into them next.
 */
function stepThroughLink(
  state: WalkState,
  link: string,
  stats: fs.Stats,
  rest: readonly string[],
  trust: ScriptDestinationTrust,
): WalkStep {
  const exposure = untrustedLinkExposure({ uid: stats.uid }, state.authority, trust);
  if (exposure) return { kind: 'reject', path: link, exposure };
  if (state.hops >= MAX_SCRIPT_PATH_LINK_HOPS) {
    return { kind: 'reject', path: link, exposure: 'link_loop_exceeded' };
  }
  const target = fs.readlinkSync(link);
  // A relative target continues from the directory that HOLDS the link, not from where the walk happens
  // to stand, and its components are queued RAW. `path.join` would fold a `..` inside the target away,
  // which is the one simplification this walk may not make: the kernel applies that `..` to the physical
  // directory it reaches after the components before it.
  const home = path.isAbsolute(target) ? '/' : path.dirname(link);
  return standIn(home, [...pathComponents(target), ...rest], trust, state.hops + 1, state.ground);
}

/**
 * How many link targets one destination walk expands before it refuses.
 *
 * Kept BELOW the smallest limit the supported kernels apply to a path (macOS 32, Linux 40), so this rule
 * reaches its own limit first and answers with its own reason. Running out of hops has NOT established
 * where the entry lands, which is a refusal rather than a pass.
 */
export const MAX_SCRIPT_PATH_LINK_HOPS = 30;

/**
/** One directory's identity, for a caller that must publish into the same one it created or checked. */
export function publishDirectoryIdentity(directory: string): string | undefined {
  if (process.platform === 'win32') return 'windows';
  const stats = statDirectoryChain(directory);
  return stats ? `${stats.dev}:${stats.ino}` : undefined;
}

export type ScriptDestinationTrust = Readonly<{
  uid: number;
  privateGid: number | undefined;
}>;

/** The fields of a directory the ancestry rule reads, so the decision is testable without a filesystem. */
export type DirectoryAuthority = Readonly<{ uid: number; gid: number; mode: number }>;

/** The fields of a symbolic link the ancestry rule reads. */
export type LinkAuthority = Readonly<{ uid: number }>;

/** The file that says which sources the host looks in for accounts and groups. */
const NSSWITCH_FILE = '/etc/nsswitch.conf';

/** The host files the private-group exception reads, in `/etc/group` field order. */
type HostGroupDatabase = Readonly<{
  /** `undefined` when the file could not be read, which is not the same as a file with no records. */
  groups: readonly string[] | undefined;
  passwd: readonly string[] | undefined;
  /** `/etc/nsswitch.conf`, which says whether the two files above are the whole story. */
  nsswitch: readonly string[] | undefined;
}>;

/** One `group:` or `passwd:` line of `/etc/nsswitch.conf`, or `undefined` when none was found. */
type NsswitchLine = Readonly<{ database: string; sources: readonly string[] }>;

/**
 * Whether `/etc/nsswitch.conf` establishes that the group and passwd files are the whole story.
 *
 * `files` is the only source admitted. `systemd` is deliberately NOT admitted, though it is the default
 * on some distributions: `systemd-userdbd` answers membership from user records these files never see,
 * which is exactly the member this rule could not read. Bracketed actions such as `[NOTFOUND=return]`
 * steer a lookup and add no source, so they are ignored. A missing line, an unparseable line, or an
 * unreadable file establishes nothing, and the exception is refused.
 *
 * A database named MORE THAN ONCE establishes nothing either. glibc appends the sources of every line
 * naming it and consults them in order, so `group: files` above `group: files sss` really does consult
 * `sss`, and keeping one of the two lines — the last, or the first — would judge by a line the lookup
 * never stopped at. {@link nsswitchLine} says how a repeated database is answered.
 */
export function nameServiceListsOnlyFiles(nsswitch: readonly string[] | undefined): boolean {
  if (nsswitch === undefined) return false;
  const databases = ['passwd', 'group', 'initgroups'].map((database) =>
    database === 'initgroups'
      ? // glibc reads SUPPLEMENTARY membership from `initgroups:`. A line that is absent inherits the
        // `group` setting, which is what the kernel does, so the verified `group` line covers it.
        (nsswitchLine(nsswitch, 'initgroups') ?? nsswitchLine(nsswitch, 'group'))
      : nsswitchLine(nsswitch, database),
  );
  return databases.every((line) => line !== undefined && listsOnlyFiles(line));
}

function listsOnlyFiles(line: NsswitchLine): boolean {
  return line.sources.length > 0 && line.sources.every((source) => source === 'files');
}

/**
 * The sources `/etc/nsswitch.conf` gives `database`, or `undefined` when it says nothing usable.
 *
 * A database named twice is answered with NO sources, which refuses the exception: the resolver
 * concatenates the sources of repeated lines, so no single line says what the lookup consults, and
 * {@link listsOnlyFiles} refuses an empty source list.
 */
function nsswitchLine(lines: readonly string[], database: string): NsswitchLine | undefined {
  let found = 0;
  let sources: readonly string[] = [];
  for (const raw of lines) {
    const source = (raw.split('#')[0] ?? '').trimStart();
    const [name, ...rest] = source.split(/[\s:]+/);
    if (name !== database) continue;
    found += 1;
    // A bracketed action steers a lookup and lists no source.
    sources = rest.filter((token) => token.length > 0 && !token.startsWith('['));
  }
  if (found === 0) return undefined;
  return { database, sources: found > 1 ? [] : sources };
}

/** One `/etc/group` record. A line without a numeric gid cannot be used to judge membership. */
type GroupRecord = Readonly<{ name: string; gid: number; members: readonly string[] }>;

/** One `/etc/passwd` record. */
type PasswdRecord = Readonly<{ name: string; uid: number; gid: number }>;

function parseGroupRecord(line: string): GroupRecord | undefined {
  const [name, , rawGid, rawMembers = ''] = line.split(':');
  const gid = Number(rawGid);
  if (name === undefined || name === '' || rawGid === '' || !Number.isInteger(gid))
    return undefined;
  return { name, gid, members: rawMembers.split(',').filter((member) => member.length > 0) };
}

function parsePasswdRecord(line: string): PasswdRecord | undefined {
  const [name, , rawUid, rawGid] = line.split(':');
  if (name === undefined || name === '') return undefined;
  return { name, uid: Number(rawUid), gid: Number(rawGid) };
}

/** This process's own account: the uid and primary gid the kernel reports, and the name it maps to. */
type CurrentAccount = Readonly<{
  uid: number | undefined;
  gid: number | undefined;
  name: string | undefined;
}>;

/**
 * The single group the private-group exception admits, or `undefined` when nothing was established.
 *
 * Ubuntu and Debian create one group per user, named after them, and set that user's home directory to
 * it, often group-writable and owned by them. Such a home is shared with no other local user, so it stays
 * a valid destination. Every other group stays outside the exception, and the rule fails closed wherever
 * completeness cannot be established:
 *
 * - {@link nameServiceListsOnlyFiles} must establish that the host's own files answer the question.
 * - Both database files must have been READ. An unreadable file is not an empty one, and an empty
 *   member list proves nothing.
 * - The gid must be this process's PRIMARY group, which `getgid` answers from the kernel, and one record
 *   carrying it must bear this user's name.
 * - EVERY record carrying that gid is read, because a directory group-writable by gid 1000 is writable
 *   by the members of each group holding the number, however named: `ada:x:1000:` beside
 *   `team:x:1000:grace` reaches grace. Any of them naming a member who is neither this user nor root ends
 *   the claim — macOS lists only part of `staff` in `/etc/group` while every local user holds it.
 * - No other passwd record may hold this gid as its primary group, and the caller's own must exist there
 *   with this uid and this gid.
 */
export function privateGroupId(
  database: HostGroupDatabase,
  current: CurrentAccount,
): number | undefined {
  if (!nameServiceListsOnlyFiles(database.nsswitch)) return undefined;
  const records = parseHostGroupDatabase(database);
  if (records === undefined) return undefined;
  return admittedPrivateGid(records, current);
}

/** The host's two databases, parsed, or `undefined` when either file could not be read. */
type HostAccounts = Readonly<{
  groups: readonly GroupRecord[];
  passwd: readonly PasswdRecord[];
}>;

function parseHostGroupDatabase(database: HostGroupDatabase): HostAccounts | undefined {
  if (!database.groups || !database.passwd) return undefined;
  return {
    groups: database.groups.flatMap((line) => {
      const record = parseGroupRecord(line);
      return record === undefined ? [] : [record];
    }),
    passwd: database.passwd.flatMap((line) => {
      const record = parsePasswdRecord(line);
      return record === undefined ? [] : [record];
    }),
  };
}

/** The decision the parsed databases allow: this gid, when it is the caller's own private group. */
function admittedPrivateGid(accounts: HostAccounts, current: CurrentAccount): number | undefined {
  const { uid, gid, name } = current;
  if (uid === undefined || gid === undefined || name === undefined) return undefined;
  const own = accounts.passwd.find((record) => record.name === name);
  if (own === undefined || own.uid !== uid || own.gid !== gid) return undefined;
  const carrying = accounts.groups.filter((record) => record.gid === gid);
  if (!carrying.some((record) => record.name === name)) return undefined;
  // EVERY record carrying this gid decides together: a directory group-writable by gid 1000 is writable
  // by the members of each of them, however they are named.
  const reachesAnybodyElse = carrying.some((record) =>
    record.members.some((member) => !memberIsTrusted(member, accounts, name)),
  );
  if (reachesAnybodyElse) return undefined;
  const sharesPrimary = accounts.passwd.some(
    (record) => record.name !== name && record.gid === gid && record.uid !== 0,
  );
  return sharesPrimary ? undefined : gid;
}

/** Whether a member of a candidate private group is the user or root, the two accounts the rule trusts. */
function memberIsTrusted(member: string, accounts: HostAccounts, name: string): boolean {
  if (member === name) return true;
  const record = accounts.passwd.find((other) => other.name === member);
  return record !== undefined && record.uid === 0;
}

/**
 * The account name this process's uid maps to, read from the host account database: the same file the
 * group records come from, so a fixture serving one serves the other. No `os.userInfo()`, which answers
 * from a different source than the records being judged.
 */
function readCurrentUser(
  passwd: readonly string[] | undefined,
  uid: number | undefined,
): string | undefined {
  if (passwd === undefined || uid === undefined) return undefined;
  for (const line of passwd) {
    const record = parsePasswdRecord(line);
    if (record?.uid === uid) return record.name;
  }
  return undefined;
}

/** This process's identity and the private group its host databases establish, if any. */
function readScriptTrust(): ScriptDestinationTrust {
  const passwd = readSystemFile('/etc/passwd');
  const uid = process.getuid?.();
  return {
    uid: uid ?? -1,
    privateGid: privateGroupId(
      {
        groups: readSystemFile('/etc/group'),
        passwd,
        nsswitch: readSystemFile(NSSWITCH_FILE),
      },
      { uid, gid: process.getgid?.(), name: readCurrentUser(passwd, uid) },
    ),
  };
}

function readSystemFile(file: string): string[] | undefined {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return undefined;
  }
}

/**
 * The ways a step of the walk can be unsafe: others can change what is in that directory, create the
 * entry the destination names, or put the link there, or the step cannot be resolved at all. The two
 * `unreachable` and `unresolvable` shapes say a walk that stopped short has no directory to report, and
 * `link_loop_exceeded` says a walk that ran out of hops has not established where the entry lands — a
 * loop is refused, never trusted. {@link untrustedGroundWording} is what each one tells the caller.
 */
export type ScriptAncestryExposure =
  | 'foreign_owned'
  | 'world_writable'
  | 'shared_group_writable'
  | 'shared_parent'
  | 'planted_link'
  | 'link_loop_exceeded'
  | 'not_a_directory'
  | 'unresolvable_parent'
  | 'unreachable_parent'
  | 'parent_replaced';

/**
 * Whether this directory is one this user can rely on a destination being inside of, and why not if it
 * is not.
 *
 * Ownership is asked first: a directory another user owns is theirs to chmod, empty and repopulate
 * whatever its mode says today, and no race is needed. Then the mode, because group- or other-writable
 * contents are open to those users directly. The sticky bit is the one exception, and sound only for
 * PASSING THROUGH: it keeps the entries already on the path in place, but cannot refuse a NEW entry by
 * name, so {@link othersCreateEntriesIn} is asked separately before anything is created inside.
 */
export function untrustedAncestryExposure(
  directory: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): ScriptAncestryExposure | undefined {
  if (directory.uid !== 0 && directory.uid !== trust.uid) return 'foreign_owned';
  if (directory.mode & 0o1000) return undefined;
  if (directory.mode & 0o002) return 'world_writable';
  if (directory.mode & 0o020 && directory.gid !== trust.privateGid) return 'shared_group_writable';
  return undefined;
}

/**
 * Whether other local users can add an entry here, which is how the destination's own name, or a
 * directory below it, becomes theirs.
 *
 * A directory somebody else owns counts: they can create, rename or replace any entry in it whatever its
 * mode says, sticky bit included, since that bit protects other people's entries from them, not their
 * own. The sticky bit is otherwise not consulted here — it cannot refuse a NEW entry by name.
 */
export function othersCreateEntriesIn(
  directory: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): boolean {
  if (directory.uid !== 0 && directory.uid !== trust.uid) return true;
  if (directory.mode & 0o002) return true;
  return Boolean(directory.mode & 0o020) && directory.gid !== trust.privateGid;
}

/**
 * Whether a symbolic link on the path is one another local user could have put there, or could replace,
 * and whose target is therefore theirs to choose.
 *
 * Where nobody but this user or root can add entries, a link cannot appear or change behind this rule.
 * Where others CAN, the sticky bit is the only thing holding an entry in place, so a link this user or
 * root owns stands and one anybody else owns does not — it may be theirs, and any of them can swap it for
 * one pointing wherever they like.
 *
 * A component stepped back over with `..` is asked as a directory, not as a link: there the caller walks
 * across it rather than publishing through it, and the directory it lands in is judged on its own.
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

/** Why each exposure makes that ground unsafe, in the caller's terms. */
const untrustedGroundWording: Record<ScriptAncestryExposure, string> = {
  foreign_owned: 'another local user owns that part of the path.',
  world_writable: 'any local user can write that part of the path.',
  shared_group_writable: 'another local user can write that part of the path.',
  shared_parent: 'another local user could create the script file there first.',
  planted_link: 'another local user could have put that symbolic link there, or could replace it.',
  link_loop_exceeded:
    'that part of the path follows more symbolic links than the system allows, so where the script would land is not established.',
  not_a_directory: 'a directory was expected there, and something else stands in the way.',
  unresolvable_parent:
    'the script path names a directory that does not exist and steps back out of it with `..`, so where the script would land is not established.',
  unreachable_parent:
    'the directory the script path names does not exist, so the script has nowhere to be written.',
  parent_replaced: '',
};

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
      reason: replaced ? 'script_ancestry_replaced' : 'script_ancestor_untrusted',
      exposure,
      path: destination,
      ancestor,
      hint: replaced
        ? 'Re-record with open --save-script, or save under a directory nobody else can write.'
        : 'Save the script under a directory you own that only you can write, and keep the path out of directories other users own.',
    },
  );
}

/** `stat` of the directory a path names, or `undefined` when it is absent or is not a directory. */
function statDirectoryChain(pathname: string): fs.Stats | undefined {
  let stats: fs.Stats | undefined;
  try {
    stats = fs.statSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return stats.isDirectory() ? stats : undefined;
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
