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
    const judged = prepareScriptDestination(options.destination).directory;
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
 * at 0700: the mode the rule accepts under every umask, including the shared-checkout 002 that would
 * otherwise leave a new directory 0775 and then refuse it.
 */
const SCRIPT_DIR_MODE = 0o700;

/**
 * Readies a script destination and reports the PHYSICAL directory to create the entry in (#4565).
 *
 * One call owns the sequence, because the ORDER is what makes "a refused destination leaves no directories
 * behind" true: the chain is WALKED, a refused destination is refused BEFORE anything is created, what is
 * missing is created at {@link SCRIPT_DIR_MODE} inside the judged directory, and the completed chain is
 * WALKED AGAIN before the answer. A caller never hands its own `mkdir` to a path this rule has not stopped.
 *
 * The second walk asks the CREATION question — whether other local users could add the destination's own
 * name inside the directory the walk ended in. The first walk does not, because below it the missing
 * directories are this call's own to create at 0700, which is what keeps
 * `mkdir -p <sticky shared>/recordings` acceptable. {@link createMissingLevels} says why each level is
 * created on its own, and why a `..` queued behind an absent name is refused by the FIRST walk.
 *
 * The answer carries the judged directory's identity, so a caller that stages bytes there can confirm the
 * ground one time before it renames, without asking the host about ground this call already judged, and
 * never runs a `mkdir` of its own.
 *
 * On Windows access is an ACL rather than a mode, so the walk is a no-op and the parent is the answer — but
 * the destination still has to be absolute first, on every platform.
 */
export function prepareScriptDestination(destination: string): ScriptDestination {
  const spelled = spelledParent(destination);
  if (process.platform === 'win32') {
    fs.mkdirSync(spelled, { recursive: true, mode: SCRIPT_DIR_MODE });
    return { directory: spelled, identity: publishDirectoryIdentity(spelled) };
  }
  const trust = scriptTrust();
  const walked = walkSpelledParent(spelled, destination, trust);
  if (walked.reject !== undefined) throw walked.reject;
  if (walked.unresolvable) {
    throw scriptAncestryFailure(destination, walked.deepest, 'unresolvable_parent');
  }
  // Where the chain already stands, this walk judged the directory the entry is created in and there is
  // nothing to create, so it is also the answer. Only a walk that stopped short creates and walks again.
  if (walked.arrived) return publishableDestination(destination, walked, trust);
  // A walk that stopped short always judged the directory it stopped in, so it has an identity to create
  // under. Anything else that did not arrive refused ground, and creates nothing.
  if (walked.identity === undefined) {
    throw scriptAncestryFailure(destination, walked.deepest, 'unreachable_parent');
  }
  createMissingLevels(destination, walked.deepest, walked.missing, trust);
  return publishableDestination(destination, walkSpelledParent(spelled, destination, trust), trust);
}

/**
 * Where a script entry is created: the PHYSICAL directory the rule judged, and that directory's identity.
 *
 * `identity` is `dev:ino` as the walk's own `lstat` answered it. It is what
 * {@link confirmScriptDestination} compares for a caller that stages bytes for a later rename, so the one
 * check a caller owes is one this host-kit makes rather than one it writes itself.
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
 * `lstat` that treats absence as `undefined`; every other errno propagates. Owned here rather than in a
 * module of its own: this file sits on the daemon's startup path, where a new module is eager code every
 * entry that publishes a file pays for (ADR 0019), and the verified-file guards are on this path already.
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
 * destination's spelling names: `home/work/../y` with `work` a link names `home/y` as text while the entry
 * lands beside the link's target. The two are therefore compared as device and inode, because `lstat` or
 * `realpathSync` applies a spelled `..` textually and answers the wrong directory.
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
 * Confirms a destination host-kit ANSWERED earlier, and reports the directory to create the entry in.
 *
 * One call, for the one check a caller that stages bytes owes: a download, a long upload or any other wait
 * can run between the walk that judged the directory and the rename that creates the entry, so the chain is
 * asked again before the entry is made. Every `parent_replaced` refusal is built by
 * {@link scriptAncestryFailure}, which is why no caller writes one: the shape a caller would copy is the
 * host-kit answer's reason, exposure, ancestor and hint, and a route that hand-rolls them drifts from the
 * rule that produced them.
 *
 * A walk that now answers a DIFFERENT directory than the answer named — an ancestor pointed at a link
 * meanwhile — is the swap this catches, and the version is refused rather than renamed into ground nobody
 * judged. Nothing here re-judges ground the walk already owns: the ownership rule is what excludes anyone
 * who could move a judged directory in the first place (ADR 0016).
 */
export function confirmScriptDestination(destination: string, prepared: ScriptDestination): string {
  const current = scriptDestination(destination);
  if (current.identity !== prepared.identity) {
    throw scriptAncestryFailure(destination, current.directory, 'parent_replaced');
  }
  return current.directory;
}

/**
 * Walks a destination that has to stand as it is, creating nothing, and judges the answer.
 *
 * Refuses a destination unless every directory the kernel looks a name up in is one no other non-root local
 * user can change (#4565). {@link prepareScriptDestination} is the same rule for a caller that also needs the
 * missing tail created; everything written there about how the walk judges ground, and about the window being
 * closed by PERMISSIONS rather than by timing, applies here too. Because nothing is created, a walk that
 * stopped short at an absent name has no answer to give and refuses as `unreachable_parent`.
 */
function scriptDestination(destination: string): ScriptDestination {
  const spelled = spelledParent(destination);
  if (process.platform === 'win32') {
    return { directory: spelled, identity: publishDirectoryIdentity(spelled) };
  }
  const trust = scriptTrust();
  const walk = walkSpelledParent(spelled, destination, trust);
  if (walk.reject !== undefined) throw walk.reject;
  if (walk.unresolvable) {
    throw scriptAncestryFailure(destination, walk.deepest, 'unresolvable_parent');
  }
  return publishableDestination(destination, walk, trust);
}

/**
 * Judges a finished walk and answers where the entry is created, with the identity THIS walk read so a
 * caller that stages bytes beside it can confirm the ground one time before its rename.
 *
 * A walk that stopped short has no answer for a publisher: the name it stopped at is not a directory the
 * entry can be created in, and the nearest ancestor it did reach is a file under a name nobody asked for.
 */
function publishableDestination(
  destination: string,
  walk: WalkOutcome,
  trust: ScriptDestinationTrust,
): ScriptDestination {
  if (walk.reject !== undefined) throw walk.reject;
  if (!walk.arrived) {
    throw scriptAncestryFailure(destination, walk.deepest, 'unreachable_parent');
  }
  // Where other local users can add entries here, one of them can add this entry first and the
  // recording is theirs.
  if (othersCreateEntriesIn(walk.authority, trust)) {
    throw scriptAncestryFailure(destination, walk.deepest, 'shared_parent');
  }
  return { directory: walk.deepest, identity: walk.identity };
}

/**
 * The parent of `destination` exactly as the caller spells it, refusing a RELATIVE destination at the entry
 * ON EVERY PLATFORM, Windows included, where no walk runs to catch it. Walking a relative name would put
 * the process's working directory into the judged chain — a name Node answers from the first query after the
 * last `chdir`, so it can name a directory the process no longer stands in while the kernel resolves the
 * destination in the moved one (ADR 0016).
 */
function spelledParent(destination: string): string {
  const parent = path.dirname(destination);
  if (!path.isAbsolute(parent)) {
    throw scriptAncestryFailure(destination, parent, 'relative_destination');
  }
  return parent;
}

/**
 * Where the walk stands: a directory it judged and physically reached, the identity that directory had as
 * the walk's own `lstat` answered it, and the names still to resolve.
 */
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
      authority: DirectoryAuthority;
      identity: string;
      /** The spelled names below the judged directory, the first of them absent. */
      missing: readonly string[];
      /** Whether a `..` is queued behind the name that stopped the walk. */
      behindUpwardStep: boolean;
    }>
  | Readonly<{ kind: 'stand'; state: WalkState }>;

/**
 * Where a walk ended. Only a walk that ARRIVED reached the directory the entry is created in, and it
 * carries that directory together with the authority and identity it was judged under, so the caller never
 * asks the host again about ground the walk has already read. Every other ending reports how far the walk
 * got, which is what a caller that creates needs in order to create below judged ground only.
 *
 * A walk that did not arrive stopped at a name that does not exist, and the nearest ancestor it did reach is
 * NOT where the entry belongs: publishing there writes a file the caller never named. `unresolvable` says a
 * `..` is queued behind that absent name, so creating cannot finish the resolution.
 */
type WalkOutcome =
  | Readonly<{
      arrived: true;
      /** The PHYSICAL directory the entry is created in. */
      deepest: string;
      authority: DirectoryAuthority;
      /** That directory's identity, as this walk's `lstat` of it answered. */
      identity: string;
      reject?: undefined;
      unresolvable?: undefined;
      missing?: undefined;
    }>
  | Readonly<{
      arrived: false;
      /** The nearest directory the walk did judge, or `/` when it refused before judging one. */
      deepest: string;
      /** That directory's identity as the walk judged it, when it judged one. */
      identity: string | undefined;
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

/** The one outcome that owns the answer: the judged directory the entry is created in. */
function arrived(state: WalkState): WalkOutcome {
  return {
    arrived: true,
    deepest: state.deepest,
    authority: state.authority,
    identity: state.identity,
  };
}

/** A walk that refused has no directory to report, because none of them is established as the entry's. */
function refused(reject: AppError): WalkOutcome {
  return {
    arrived: false,
    deepest: '/',
    identity: undefined,
    reject,
    unresolvable: false,
    missing: [],
  };
}

function stoppedShort(step: Extract<WalkStep, { kind: 'short' }>): WalkOutcome {
  return {
    arrived: false,
    deepest: step.deepest,
    identity: step.identity,
    reject: undefined,
    unresolvable: step.behindUpwardStep,
    missing: step.missing,
  };
}

/** The first state: the root, with every component of the parent still to resolve. */
function startWalk(parent: string, trust: ScriptDestinationTrust): WalkStep {
  return standOn('/', pathComponents(parent), trust, 0);
}

/**
 * Stands the walk on `directory`, judged from this call's own `lstat` of it, or refuses it.
 *
 * A name come back around through a `..` or an alias is judged again from a fresh `lstat`, and reaches the
 * judgment it had on the first visit. The rule keeps no memory of ground it already owned, because a
 * directory it stands in is one this user or root owns that others cannot write in, or a sticky one where an
 * entry of this user's cannot be replaced (ADR 0016).
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

/** The fields this rule reads off one `lstat` answer: owner, group and mode of the ENTRY. */
function directoryAuthority(stats: fs.BigIntStats): DirectoryAuthority {
  return { uid: Number(stats.uid), gid: Number(stats.gid), mode: Number(stats.mode) };
}

/**
 * The device and inode an `lstat` answer names.
 *
 * BIGINT stats: a numeric `ino` cannot hold every inode a filesystem hands out, so two distinct large inodes
 * would collapse onto one identity, the collision the one retained comparison exists to catch.
 */
function identityOf(stats: fs.BigIntStats): string {
  return `${stats.dev}:${stats.ino}`;
}

/** `lstat` with bigint ids, treating absence as `undefined`: the only lookup this rule makes. */
function lstatEntry(pathname: string): fs.BigIntStats | undefined {
  return fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
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
  // it. A caller that creates makes that tail; a caller that creates nothing refuses. Neither goes on as
  // if the name had resolved.
  if (stats === undefined) {
    return {
      kind: 'short',
      deepest: state.deepest,
      authority: state.authority,
      identity: state.identity,
      missing: [component, ...rest],
      behindUpwardStep: rest.includes('..'),
    };
  }
  // This lstat IS the judgment: type, owner and mode of the ENTRY the name holds. Asking the same name
  // again with `stat` would answer whatever stands there by then, which on a race is a link somebody else
  // put there, and the walk would judge the target's permissions while entering on the name.
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

/**
 * One hop. The link is judged where it physically stands, and its target's components enter the queue,
 * because the kernel steps into them next.
 */
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
  // A relative target continues from the directory that HOLDS the link, not from where the walk happens
  // to stand, and its components are queued RAW. `path.join` would fold a `..` inside the target away,
  // which is the one simplification this walk may not make: the kernel applies that `..` to the physical
  // directory it reaches after the components before it.
  const home = path.isAbsolute(target) ? '/' : path.dirname(link);
  return standOn(home, [...pathComponents(target), ...rest], trust, state.hops + 1);
}

/**
 * How many link targets one destination walk expands before it refuses.
 *
 * Kept BELOW the smallest limit the supported kernels apply to a path (macOS 32, Linux 40), so this rule
 * reaches its own limit first and answers with its own reason. Running out of hops has NOT established
 * where the entry lands, which is a refusal rather than a pass.
 */
export const MAX_SCRIPT_PATH_LINK_HOPS = 30;

/** One directory's identity, so a route that runs no walk on Windows can still answer with one. */
function publishDirectoryIdentity(directory: string): string | undefined {
  if (process.platform === 'win32') return 'windows';
  const stats = lstatEntry(directory);
  return stats ? identityOf(stats) : undefined;
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
  | 'entry_appeared'
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
 * The typed reasons a destination-ancestry refusal answers with.
 *
 * A caller that reports WHY a script was not saved reads one of these out of the refusal and passes it on;
 * they are named here, and not spelled again by whoever reads them, because the refusal is built here.
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

/**
 * Creates the tail the walk found missing, ONE LEVEL AT A TIME, inside the directory the walk judged.
 *
 * A recursive `mkdir` cannot be used here even though it takes a mode: it resolves the whole tail as text, so
 * a link planted at one of those missing names carries the creation to its far side, where as root it creates
 * with privileges. One non-recursive `mkdir` lands inside the directory this call established, nowhere else.
 *
 * A name that was absent when the walk looked and exists by the time `mkdir` reaches it is JUDGED, not
 * refused and not trusted: two processes saving into the same new directory meet here. The entry under the
 * name is read by the same single `lstat` every other step is read by and judged by the same rule, which
 * accepts a private directory this user owns and refuses a link or a foreign one. A level that passes
 * becomes the directory the next name is created in, so creation never follows a name the rule did not take.
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
  // The `lstat` of the NAME, taken after the creation attempt, is the judgment either way: what this call
  // made and what arrived beside it are read the same way and judged by the same rule.
  const seen = lstatEntry(level);
  if (seen === undefined || !seen.isDirectory()) {
    throw scriptAncestryFailure(destination, level, created ? 'not_a_directory' : 'entry_appeared');
  }
  const authority = directoryAuthority(seen);
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) throw scriptAncestryFailure(destination, level, exposure);
  if (created) {
    // The creation carries the mode, and this forces it: `mkdir` ANDs it with the umask, so under the
    // shared-checkout 002 the level would stand 0775 and the walk that follows would refuse it.
    fs.chmodSync(level, SCRIPT_DIR_MODE);
    return level;
  }
  // Somebody else's directory, and the one place this rule asks whether OTHER users could add a name here:
  // below a directory they can write, the destination's own name can be made before this call.
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
