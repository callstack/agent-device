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
 * This is `publishFileSync` plus the destination-ancestry rule (#4565), asked through
 * {@link prepareScriptDestination}: it creates what the destination is missing and answers with the
 * directory to create the entry in. The chain is judged once here, and the file is private, because a
 * recording is a transcript of what someone did on this machine.
 */
export function publishScriptFileSync(options: {
  destination: string;
  contents: string;
  publish?: AtomicPublishMode;
}): void {
  let temporaryPath: string | undefined;
  try {
    // The directory the entry is created in is the walk's ANSWER and never `path.dirname` of the
    // spelling: a `..` or a link sends the entry elsewhere, and a temp file staged where the text points
    // is one another local user can reach and put their bytes behind.
    const judged = prepareScriptDestination(options.destination);
    temporaryPath = createAtomicPublishTempPath(judged, options.destination);
    fs.writeFileSync(temporaryPath, options.contents, { encoding: 'utf8', mode: SCRIPT_FILE_MODE });
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

/**
 * A directory a script publish creates is itself judged on the way to a later version, so it is created
 * at 0700: the mode the rule accepts under every umask. A recursive `mkdir` applies the mode to every
 * level it creates, so a creation on the usual umask-002 host is not left 0775 and then refused.
 */
const SCRIPT_DIR_MODE = 0o700;

/**
 * Readies a script destination and reports the PHYSICAL directory to create the entry in (#4565).
 *
 * One call owns the sequence, because the order is what makes "a refused destination leaves no
 * directories behind" true: the chain is WALKED, a destination the rule refuses is refused BEFORE
 * anything is created, what is missing is created at {@link SCRIPT_DIR_MODE} inside the directory the
 * walk judged, and the now-complete chain is JUDGED again before the answer. A caller never hands its own
 * `mkdir` to a path this rule has not stopped first.
 *
 * The second walk asks the creation question — whether other local users could add the destination's own
 * name inside the directory the walk ended in. The first walk does not, because below it the missing
 * directories are this call's own to create, at 0700, which is what keeps
 * `mkdir -p <sticky shared>/recordings` acceptable.
 *
 * A `..` queued behind the first component that does not exist is refused by the FIRST walk: creating
 * cannot resolve it, because the kernel applies that step only to a directory that already exists, while
 * a recursive `mkdir` resolves the same spelling as text and builds what stands on the far side of it.
 *
 * On Windows access is an ACL rather than a mode, so the rule is a no-op and the parent is the answer.
 */
export function prepareScriptDestination(destination: string): string {
  if (process.platform === 'win32') {
    const parent = path.dirname(path.resolve(destination));
    fs.mkdirSync(parent, { recursive: true, mode: SCRIPT_DIR_MODE });
    return parent;
  }
  const spelled = spelledParent(destination);
  const trust = scriptTrust();
  const walked = walkSpelledParent(spelled, destination, trust);
  if (walked.reject !== undefined) throw walked.reject;
  if (walked.unresolvable) {
    throw scriptAncestryFailure(destination, walked.deepest, 'unresolvable_parent');
  }
  // Where the chain already stands, this walk judged the directory the entry is created in and there is
  // nothing to create, so it is also the answer. Only a walk that stopped short walks again.
  if (walked.arrived) return publishableDirectory(destination, walked, trust);
  fs.mkdirSync(path.join(walked.deepest, ...walked.missing), {
    recursive: true,
    mode: SCRIPT_DIR_MODE,
  });
  return publishableDirectory(destination, walkSpelledParent(spelled, destination, trust), trust);
}

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
 * A group-writable directory is refused outright: membership cannot be proven from the host's account
 * files, so ADR 0016 carries no private-group exception, and the hint says to `chmod g-w` the directory.
 *
 * A component that is neither a directory nor a link is refused as `not_a_directory`: the kernel cannot
 * travel through it either. On Windows access is an ACL, so this rule is a no-op and answers the parent
 * it was given.
 *
 * `parentIdentity` is what {@link publishDirectoryIdentity} returned for the directory an earlier walk
 * judged. Only the remote route passes one, because a download runs between its two walks: the rule above
 * already excludes anyone who could swap that directory, so the comparison is defense in depth against a
 * host whose modes moved meanwhile, not what closes the window.
 */
export function assertPrivateScriptDestination(
  destination: string,
  parentIdentity?: string,
): string {
  if (process.platform === 'win32') return path.dirname(path.resolve(destination));
  const trust = scriptTrust();
  const walk = walkSpelledParent(spelledParent(destination), destination, trust);
  if (walk.unresolvable) {
    throw scriptAncestryFailure(destination, walk.deepest, 'unresolvable_parent');
  }
  return publishableDirectory(destination, walk, trust, parentIdentity);
}

/**
 * Judges a finished walk and reports the directory to create the entry in.
 *
 * A walk that stopped short has no answer for a publisher: the name it stopped at is not a directory the
 * entry can be created in, and the nearest ancestor it did reach is a file under a name nobody asked for.
 *
 * The identity is asked of the directory the walk answered, which is NOT `path.dirname` of the spelling:
 * where a `..` or a link leads elsewhere, the spelled parent is a different directory and comparing
 * against it reports a replacement that never happened.
 */
function publishableDirectory(
  destination: string,
  walk: WalkOutcome,
  trust: ScriptDestinationTrust,
  parentIdentity?: string,
): string {
  if (walk.reject !== undefined) throw walk.reject;
  if (!walk.arrived) {
    throw scriptAncestryFailure(destination, walk.deepest, 'unreachable_parent');
  }
  if (parentIdentity !== undefined && publishDirectoryIdentity(walk.deepest) !== parentIdentity) {
    throw scriptAncestryFailure(destination, walk.deepest, 'parent_replaced');
  }
  // Where other local users can add entries here, one of them can add this entry first and the
  // recording is theirs. The authority the walk read is reused rather than read again.
  if (othersCreateEntriesIn(walk.authority, trust)) {
    throw scriptAncestryFailure(destination, walk.deepest, 'shared_parent');
  }
  return walk.deepest;
}

/**
 * The parent of `destination` exactly as the caller spells it, refusing a RELATIVE destination at the
 * entry. Both routes resolve the caller's path to absolute before asking, and walking a relative name
 * would put the process's working directory into the judged chain — a name Node answers from the first
 * query after the last `chdir`, so it can name a directory the process no longer stands in while the
 * kernel resolves the destination in the moved one (ADR 0016).
 */
function spelledParent(destination: string): string {
  const parent = path.dirname(destination);
  if (!path.isAbsolute(parent)) {
    throw scriptAncestryFailure(destination, parent, 'relative_destination');
  }
  return parent;
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
      /** The spelled names below the judged directory, the first of them absent. */
      missing: readonly string[];
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
/**
 * Where a walk ended. Only a walk that ARRIVED reports ground to publish inside, so only it has an
 * authority to judge; every other ending reports how far the walk got, which is what a caller that
 * creates needs in order to create below judged ground only.
 */
type WalkOutcome =
  | Readonly<{
      arrived: true;
      /** The PHYSICAL directory the entry is created in. */
      deepest: string;
      authority: DirectoryAuthority;
      reject?: undefined;
      unresolvable?: undefined;
      missing?: undefined;
    }>
  | Readonly<{
      arrived: false;
      /** The nearest directory the walk did judge, or `/` when it refused before judging one. */
      deepest: string;
      /** The step that made the chain unsafe, when an existing step refused rather than went missing. */
      reject: AppError | undefined;
      /** Whether a `..` is queued behind the absent name, so creating cannot resolve the chain. */
      unresolvable: boolean;
      /** The spelled names below `deepest`, the first of them absent. */
      missing: readonly string[];
      authority?: undefined;
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
 *   directory the walk did reach, and the outcome says so: `arrived` is false, `missing` is the tail
 *   below that point, and `unresolvable` is true when a `..` is queued behind that name.
 * - A directory is judged and entered. Each path is read from the host once per walk, so a `..` back over
 *   ground already crossed, or an alias of it, does not ask the host again.
 * - A symbolic link is judged itself, against the directory that physically holds it, and its target's
 *   RAW components go in front of the queue — restarting from `/` for an absolute target, continuing from
 *   the link's own directory for a relative one. Hops are counted against
 *   {@link MAX_SCRIPT_PATH_LINK_HOPS}, and crossing it is refused rather than trusted.
 * - A component that is neither a directory nor a link cannot carry a publish, and is refused.
 *
 * `parent` is the caller's own spelling, which is what both this walk and any creation it authorizes
 * resolve. `destination` appears only in refusals, which name the path the caller passed.
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
      return refused(scriptAncestryFailure(destination, step.path, step.exposure));
    }
    if (step.kind === 'short') return stoppedShort(step);
    const { state } = step;
    const [component, ...rest] = state.queue;
    // The only exit that ARRIVES: an empty queue, every name the parent spelled resolved and judged.
    if (component === undefined) return arrived(state);
    step = stepThrough(state, component, rest, trust);
  }
}

/** A walk that refused has no directory to report, because none of them is established as the entry's. */
/** The one outcome that owns the answer: the judged directory the entry is created in. */
function arrived(state: WalkState): WalkOutcome {
  return {
    arrived: true,
    deepest: state.deepest,
    authority: state.authority,
  };
}

/** A walk that refused has no directory to report, because none of them is established as the entry's. */
function refused(reject: AppError): WalkOutcome {
  return {
    arrived: false,
    deepest: '/',
    reject,
    unresolvable: false,
    missing: [],
  };
}

function stoppedShort(step: Extract<WalkStep, { kind: 'short' }>): WalkOutcome {
  return {
    arrived: false,
    deepest: step.deepest,
    reject: undefined,
    unresolvable: step.behindUpwardStep,
    missing: step.missing,
  };
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
 * walk arrives, and {@link walkSpelledParent} answers that itself.
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
  // Nothing below here exists yet, so the walk stops at the ground it judged and reports the tail under
  // it. A caller that creates makes that tail; a caller that creates nothing refuses. Neither goes on as
  // if the name had resolved.
  if (stats === undefined) {
    return {
      kind: 'short',
      deepest: state.deepest,
      authority: state.authority,
      missing: [component, ...rest],
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

/** One directory's identity, for a caller that must publish into the same one it created or checked. */
export function publishDirectoryIdentity(directory: string): string | undefined {
  if (process.platform === 'win32') return 'windows';
  const stats = statDirectoryChain(directory);
  return stats ? `${stats.dev}:${stats.ino}` : undefined;
}

/**
 * What this process may rely on when it judges ground: who it is, as the kernel answers. Nothing else —
 * the rule reads no account database, so its answer does not depend on which name services run (ADR 0016).
 */
export type ScriptDestinationTrust = Readonly<{ uid: number }>;

/** What this process may rely on when it judges ground. */
function scriptTrust(): ScriptDestinationTrust {
  return { uid: process.getuid?.() ?? -1 };
}

/** The fields of a directory the ancestry rule reads, so the decision is testable without a filesystem. */
export type DirectoryAuthority = Readonly<{ uid: number; gid: number; mode: number }>;

/** The fields of a symbolic link the ancestry rule reads. */
export type LinkAuthority = Readonly<{ uid: number }>;

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
  | 'relative_destination'
  | 'unresolvable_parent'
  | 'unreachable_parent'
  | 'parent_replaced';

/**
 * Whether this directory is one this user can rely on a destination being inside of, and why not if it
 * is not.
 *
 * Ownership is asked first: a directory another user owns is theirs to chmod, empty and repopulate
 * whatever its mode says today, and no race is needed. Then the mode, because group- or other-writable
 * contents are open to those users directly. A group-writable directory is refused whoever owns the group:
 * proving one holds no other user means reading the host's account files, which ADR 0016 declines to do,
 * so the mode alone decides and the hint says to `chmod g-w`. The sticky bit is the one mode exception,
 * and sound only for PASSING THROUGH: it keeps the entries already on the path in place, but cannot refuse
 * a NEW entry by name, so {@link othersCreateEntriesIn} is asked separately before anything is created.
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
  return Boolean(directory.mode & 0o020);
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
  shared_group_writable:
    'the group can write that part of the path, and agent-device cannot tell who else belongs to that group.',
  shared_parent: 'another local user could create the script file there first.',
  planted_link: 'another local user could have put that symbolic link there, or could replace it.',
  link_loop_exceeded:
    'that part of the path follows more symbolic links than the system allows, so where the script would land is not established.',
  not_a_directory: 'a directory was expected there, and something else stands in the way.',
  relative_destination:
    'the script path has to be absolute, so the directories it names are the ones that get checked.',
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
      hint: ancestryHint(exposure, ancestor),
    },
  );
}

/**
 * What to do about it. A group-writable directory is the one refusal the caller can fix in place, because
 * the mode alone is what this rule cannot resolve: it cannot tell who else belongs to that group.
 */
function ancestryHint(exposure: ScriptAncestryExposure, ancestor: string): string {
  if (exposure === 'parent_replaced') {
    return 'Re-record with open --save-script, or save under a directory nobody else can write.';
  }
  if (exposure === 'shared_group_writable') {
    return `Close the directory to its group with \`chmod g-w ${ancestor}\`, or save the script under a directory only you can write.`;
  }
  return 'Save the script under a directory you own that only you can write, and keep the path out of directories other users own.';
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
