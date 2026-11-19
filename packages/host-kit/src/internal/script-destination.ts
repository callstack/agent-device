import fs from 'node:fs';
import path from 'node:path';
import {
  identityOf,
  lstatEntry,
  publishFileSync,
  type AtomicPublishMode,
} from './atomic-publish.ts';
import {
  entryNameOrRefuse,
  requireWindowsScriptVolume,
  scriptEntryNameOrRefuse,
} from './entry-name.ts';
import { hostPathRules } from './path-resolution.ts';
import {
  scriptAncestryFailure,
  type ScriptAncestryExposure,
} from './script-destination-refusal.ts';

/**
 * What this process may rely on when it judges ground: who it is, as the kernel answers. The rule reads no
 * account database, so the answer does not depend on which name services run (ADR 0016). Every judgment below
 * decides over the fields of one `lstat`, so each is testable on its values.
 */
export type ScriptDestinationTrust = Readonly<{ uid: number; privateAncestry?: boolean }>;

/**
 * How strictly a caller's destination is judged. `privateAncestry` is for executable state, such as the Swift
 * helper cache: no directory the walk traverses may be group- or world-writable, sticky or not, because a
 * sticky shared directory lets another user claim a name a cleaner removed (ADR 0016).
 */
export type ScriptDestinationOptions = Readonly<{ privateAncestry?: boolean }>;

export function scriptTrust(options: ScriptDestinationOptions): ScriptDestinationTrust {
  return { uid: process.getuid?.() ?? -1, privateAncestry: options.privateAncestry === true };
}

/**
 * The fields of a directory, or of a link, that the ancestry rule reads. The group id is deliberately absent,
 * for the account-file reason ADR 0016 states.
 */
export type DirectoryAuthority = Readonly<{ uid: number; mode: number }>;

export type LinkAuthority = Readonly<{ uid: number }>;

/**
 * Whether this user can rely on a destination being inside `directory`, and why not if they cannot. The
 * ownership-first order, the group-writable refusal, and the one sticky-bit exception are ADR 0016's; the
 * exception holds only for PASSING THROUGH, so {@link othersCreateEntriesIn} is asked separately before a name
 * is created.
 */
export function untrustedAncestryExposure(
  directory: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): ScriptAncestryExposure | undefined {
  if (directory.uid !== 0 && directory.uid !== trust.uid) return 'foreign_owned';
  if (directory.mode & 0o1000 && !trust.privateAncestry) return undefined;
  if (directory.mode & 0o002) return 'world_writable';
  if (directory.mode & 0o020) return 'shared_group_writable';
  return undefined;
}

/**
 * Whether other local users can add an entry here, which is how the destination's own name becomes theirs. A
 * directory somebody else owns counts whatever its mode says: the sticky bit shields other people's entries
 * (ADR 0016).
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
 * target is therefore theirs to choose (ADR 0016).
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

/**
 * Publishes a session script, and nothing else: {@link publishFileSync} at {@link SCRIPT_FILE_MODE}, with the
 * destination-ancestry rule asked through {@link prepareScriptDestination}. A recording is a transcript of what
 * someone did here, so it is private, and the mode is asked EXACT: the umask of a shared checkout would
 * otherwise narrow it away from what the rule publishes everywhere else.
 */
export function publishScriptFileSync(options: {
  destination: string;
  contents: string;
  publish?: AtomicPublishMode;
}): string {
  // The entry is the one the rule authorized, never the caller's spelling: a `..` or a link sends the entry
  // elsewhere, and a temporary sibling beside that spelling is one another local user can reach (ADR 0016).
  const { entry } = prepareScriptDestination(options.destination);
  publishFileSync({
    destination: entry,
    contents: options.contents,
    mode: SCRIPT_FILE_MODE,
    publish: options.publish,
    exactMode: true,
  });
  return entry;
}

/** A recording holds literals a `fill` did not parameterize (ADR 0017), so it is written private. */
const SCRIPT_FILE_MODE = 0o600;

/**
 * A directory a publish creates is itself judged on the way to a later version, so it is created at the mode
 * the rule accepts under every umask — the shared-checkout umask 002 would otherwise leave it 0775 and refuse.
 */
export const SCRIPT_DIR_MODE = 0o700;

/**
 * Readies a script destination and reports the PHYSICAL directory to create the entry in, in ADR 0016's order:
 * walk, refuse before anything is created, create what is missing, walk the completed chain again, answer.
 */
export function prepareScriptDestination(
  destination: string,
  options: ScriptDestinationOptions = {},
): ScriptDestination {
  return scriptDestination(destination, true, options);
}

/**
 * ADR 0016's judgment of one destination. `create` says whether the caller needs the missing tail created:
 * a walk that stops short is an answer for that caller and a refusal for the other.
 */
function scriptDestination(
  destination: string,
  create: boolean,
  options: ScriptDestinationOptions = {},
): ScriptDestination {
  if (process.platform === 'win32') {
    return windowsScriptDestination(destination, create);
  }
  // A relative spelling is refused first, whatever its last segment, because that is what makes it unjudgeable.
  const spelled = spelledParent(destination);
  const name = scriptEntryNameOrRefuse(destination);
  const trust = scriptTrust(options);
  // The walk answers the COMPLETED chain, so this is the one place the CREATION question is asked: below the
  // walk the missing directories are this call's own to create, and asking it before creation would refuse
  // `mkdir -p <sticky shared>/recordings`, where those levels are 0700 of this call's own (ADR 0016).
  const arrived = walkSpelledParent(spelled, destination, trust, create);
  if (othersCreateEntriesIn(arrived.authority, trust)) {
    throw scriptAncestryFailure(destination, arrived.deepest, 'shared_parent');
  }
  return authorizedEntry(arrived.deepest, arrived.identity, name);
}

function windowsScriptDestination(destination: string, create: boolean): ScriptDestination {
  const rules = path.win32;
  const root = requireWindowsScriptVolume(destination, destination);
  const name = entryNameOrRefuse(destination, rules);
  const directory = rules.dirname(rules.normalize(destination));
  requireWindowsScriptDirectory(destination, root);
  if (directory === root) return authorizedEntry(directory, 'windows', name);
  if (create) createWindowsScriptParents(destination, root, directory);
  else requireWindowsScriptDirectory(destination, directory);
  return authorizedEntry(directory, 'windows', name);
}

function createWindowsScriptParents(destination: string, root: string, directory: string): void {
  const missing: string[] = [];
  let parent = directory;
  // Start at the requested parent so a traverse-only ancestor needs no attribute read.
  while (parent !== root && !makeWindowsScriptDirectory(destination, parent)) {
    missing.push(parent);
    parent = path.win32.dirname(parent);
  }
  if (parent === root) throw scriptAncestryFailure(destination, root, 'unreachable_parent');
  for (const child of missing.reverse()) {
    if (!makeWindowsScriptDirectory(destination, child)) {
      throw scriptAncestryFailure(destination, child, 'unreachable_parent');
    }
  }
}

function makeWindowsScriptDirectory(destination: string, directory: string): boolean {
  try {
    fs.mkdirSync(directory, { mode: SCRIPT_DIR_MODE });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    if (code !== 'EEXIST') throw error;
    requireWindowsScriptDirectory(destination, directory);
  }
  return true;
}

function requireWindowsScriptDirectory(destination: string, directory: string): void {
  let stats: fs.Stats | undefined;
  try {
    stats = fs.statSync(directory, { throwIfNoEntry: false });
  } catch (error) {
    if (!isWindowsShareUnavailable(directory, error)) throw error;
  }
  if (!stats) throw scriptAncestryFailure(destination, directory, 'unreachable_parent');
  if (!stats.isDirectory()) throw scriptAncestryFailure(destination, directory, 'not_a_directory');
}

/** Windows reports a deleted share as a connection reset through libuv. */
export function isWindowsShareUnavailable(file: string, error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    /^[\\/]{2}/.test(file) &&
    (error as NodeJS.ErrnoException | undefined)?.code === 'ECONNRESET'
  );
}

function authorizedEntry(
  directory: string,
  identity: string | undefined,
  name: string,
): ScriptDestination {
  return { directory, identity, name, entry: hostPathRules().join(directory, name) };
}

/**
 * The entry a script is created as: the PHYSICAL directory the rule judged, that directory's identity as the
 * walk's own `lstat` answered it — what {@link confirmScriptDestination} compares before a rename — and the
 * validated name. `entry` is the one path a publisher creates.
 */
export type ScriptDestination = Readonly<{
  directory: string;
  identity: string | undefined;
  name: string;
  entry: string;
}>;

/**
 * Judges a destination that is already in place, creating nothing, and reports its entry: what a caller
 * answers about a version it published before (ADR 0016).
 */
export function judgeScriptDestination(destination: string): ScriptDestination {
  return scriptDestination(destination, false);
}

/**
 * Confirms a destination host-kit ANSWERED earlier, and reports the entry to create. The one check a caller
 * that stages bytes owes, for the reason ADR 0016 states. The entry is authorized only when this walk reaches
 * the same directory.
 */
export function confirmScriptDestination(
  destination: string,
  prepared: ScriptDestination,
): ScriptDestination {
  const current = scriptDestination(destination, false);
  // The directory is compared too: Windows answers one constant identity for every directory.
  if (current.identity !== prepared.identity || current.directory !== prepared.directory) {
    throw scriptAncestryFailure(destination, current.directory, 'parent_replaced');
  }
  return current;
}

/**
 * The parent of `destination` exactly as the caller spells it, refusing a RELATIVE destination on every
 * platform, Windows included, where no walk runs to catch it (ADR 0016).
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
  /** Names left to resolve, nearest first, each marked with where it came from. */
  queue: readonly QueueName[];
  /** Link targets expanded so far. */
  hops: number;
}>;

/**
 * What a walk is asked to refuse beyond ADR 0016's rules, and where it reports having refused.
 *
 * The destination rule follows a link wherever only this user could have put it, because passing THROUGH such a
 * link is the caller's own choice. A caller that CREATES names in, or NARROWS the mode of, a directory it was
 * given asks more of the route: a link standing AT that directory or below it would move those bytes, or that
 * mode change, to ground the caller never named. Such a caller names the position its own ground starts at, and
 * reads {@link WalkRefusal} to learn where the walk stopped.
 */
export type WalkPolicy = Readonly<{
  /** Refuse a symbolic link standing at this route position or below. Positions count the caller's own names. */
  noLinksAtRouteNameOrBelow?: number;
  /**
   * Whether EVERY directory the walk stands on — including the ones above the caller's own ground — is refused
   * for letting other local users ADD a name, sticky bit or not.
   *
   * The destination rule asks that question only of the directory an entry is created in, because passing
   * THROUGH a shared directory is the caller's own choice. A caller that writes its own records along a route
   * it was handed asks it of every level: a shared directory anywhere on the route can hold a link that
   * re-lands the rest of the route somewhere else, and records then land in ground nothing judged.
   */
  sharedLevelRefusedOnRoute?: boolean;
  /**
   * ANSWER slot: filled with which of the caller's own names the refusal was about, or left `undefined` when the
   * walk never refused an entry. A caller reads this instead of comparing the refusal's PATH with its own,
   * because the walk spells the ground it ARRIVED AT: an alias such as macOS's `/var` gives one directory two
   * spellings, and a text comparison would read a refusal about the caller's own directory as a refusal about
   * something further up.
   */
  refusal: WalkRefusal;
}>;

/**
 * The ANSWER slot of {@link WalkPolicy}: which of the caller's own names a refusal was about, as the walk
 * counted them, or `undefined` when the walk refused nothing. The caller holds this object and the walk writes
 * it, so the policy itself stays read-only.
 */
export type WalkRefusal = { atRouteName: number | undefined };

/**
 * The ground a walk answered: the PHYSICAL directory the entry is created in, with the authority and identity it
 * was judged under, so the caller never asks the host about ground the walk already read.
 */
export type WalkGround = Readonly<{
  deepest: string;
  authority: DirectoryAuthority;
  /** That directory's identity, as this walk's `lstat` of it answered. */
  identity: string;
}>;

/** The tail a walk stopped below: the nearest judged directory and the spelled names absent beneath it. */
type ShortTail = Readonly<{
  /** The nearest directory the walk did judge; the destination's name is absent below it. */
  deepest: string;
  /** The spelled names below `deepest`, the first of them absent. */
  missing: readonly string[];
  /** Whether a `..` is queued behind that name, so creating cannot resolve the chain. */
  unresolvable: boolean;
}>;

/**
 * Walks the spelled parent exactly as the kernel resolves a path — the resolution ADR 0016 describes: no
 * `realpath`, `..` applied to the directory physically stood in, a link's raw components queued ahead of the
 * rest, hops capped at {@link MAX_SCRIPT_PATH_LINK_HOPS}. It throws at the first step another local user could
 * steer; `destination` appears only in the refusal that names it.
 *
 * A caller that creates gets the ANSWER FOR THE COMPLETED CHAIN: the walk stops at the first absent name, makes
 * that tail inside the directory it judged, and judges the chain again from the root, because creating is the
 * one moment ground below this call's feet changes. Anything still short then is a refusal.
 *
 * The queue carries whether each name came from the caller's path or from a link's target, so a policy can tell
 * an ancestor alias from a link at the directory the caller named, and a caller that repairs ground can tell
 * whether the refusal it got was about that directory or about one further up.
 */
export function walkSpelledParent(
  parent: string,
  destination: string,
  trust: ScriptDestinationTrust,
  create: boolean,
  policy?: WalkPolicy,
): WalkGround {
  const run = newWalk(parent, destination, trust, policy);
  for (;;) {
    const step = advanceWalk(run);
    if (step === 'arrived') {
      return {
        deepest: run.state.deepest,
        authority: run.state.authority,
        identity: run.state.identity,
      };
    }
    if (step === 'stepped') continue;
    // Nothing stands below here. A caller that creates makes that tail and is judged again; a step back out of a
    // directory that is not there is something no amount of creating resolves.
    if (!create || run.created || step.unresolvable) {
      refuseOn(run, step.deepest, step.unresolvable ? 'unresolvable_parent' : 'unreachable_parent');
    }
    createMissingLevels(destination, step.deepest, step.missing, trust);
    // The chain is made ONCE: a second short tail means something is removing levels under this call, and
    // nothing further it creates can be trusted to stay.
    run.created = true;
    startRoute(run);
  }
}

/** The walk's progress through one spelled parent, mutable because it is a walk and not a lookup. */
type WalkRun = Readonly<{
  parent: string;
  destination: string;
  trust: ScriptDestinationTrust;
  policy: WalkPolicy | undefined;
}> & {
  state: WalkState;
  /**
   * Which of the CALLER's own names the step in flight resolves; `undefined` for ground the route never named,
   * such as `/`, the inside of a link's target, or the parent of one. A link's target contributes no name of the
   * caller's, which is what lets a policy tell an allowed ancestor alias from a link standing in the caller's own
   * ground, and a caller that repairs ground tell a refusal about its own directory from one above it.
   */
  atRouteName: number | undefined;
  /** Whether this walk has already created a level, since a chain is made once and then judged again. */
  created: boolean;
};

function newWalk(
  parent: string,
  destination: string,
  trust: ScriptDestinationTrust,
  policy: WalkPolicy | undefined,
): WalkRun {
  const run: WalkRun = {
    parent,
    destination,
    trust,
    policy,
    state: undefined as unknown as WalkState,
    atRouteName: undefined,
    created: false,
  };
  startRoute(run);
  return run;
}

/** Puts the walk back at `/` with the caller's whole route queued, which is what a re-judgment does. */
function startRoute(run: WalkRun): void {
  run.atRouteName = undefined;
  run.state = standOn(
    run,
    '/',
    pathComponents(run.parent).map((name) => ({ name, route: true })),
    0,
  );
}

/** Where one step leaves the walk: it arrived, it moved, or the chain is short of a name. */
type WalkStep = 'arrived' | 'stepped' | ShortTail;

/** Resolves the nearest queued name, or reports that the walk is standing where the chain runs out. */
function advanceWalk(run: WalkRun): WalkStep {
  const [entry, ...rest] = run.state.queue;
  if (entry === undefined) return 'arrived';
  if (entry.route) run.atRouteName = (run.atRouteName ?? -1) + 1;
  // `..` is the parent of the directory PHYSICALLY stood in, not of the spelling: where `work` is a link,
  // `.../work/../x` steps back from the link's target and lands beside it. The route POSITION survives a step
  // that is not the caller's: clearing it at an alias's own `..` would recount every caller name below the
  // alias from zero, blinding the state rule's position-bounded refusal and repair gate to its own ground.
  if (entry.name === '..') {
    if (entry.route) run.atRouteName = undefined;
    run.state = standOn(run, path.dirname(run.state.deepest), rest, run.state.hops);
    return 'stepped';
  }
  const standing = path.join(run.state.deepest, entry.name);
  const stats = lstatEntry(standing);
  if (stats === undefined) {
    return {
      deepest: run.state.deepest,
      missing: [entry.name, ...rest.map((name) => name.name)],
      unresolvable: rest.some((name) => name.name === '..'),
    };
  }
  run.state = judgedEntryStep(run, standing, stats, rest);
  return 'stepped';
}

/**
 * The directory one named entry leads to, judged by this call's own `lstat` of the NAME (ADR 0016).
 */
function judgedEntryStep(
  run: WalkRun,
  standing: string,
  stats: fs.BigIntStats,
  rest: readonly QueueName[],
): WalkState {
  if (stats.isSymbolicLink()) return linkStep(run, standing, stats, rest);
  if (!stats.isDirectory()) refuseOn(run, standing, 'not_a_directory');
  const authority = directoryAuthority(stats);
  const exposure = untrustedAncestryExposure(authority, run.trust);
  if (exposure) refuseOn(run, standing, exposure);
  // A caller that writes its OWN records along this route asks the creation question here too, at every
  // level of its own ground: ADR 0016's answer covers PASSING THROUGH, and a sticky shared directory the
  // route rides through still lets another local user plant the link that re-lands everything below it.
  if (refusesSharedLevelOnRoute(run) && othersCreateEntriesIn(authority, run.trust))
    refuseOn(run, standing, 'shared_parent');
  return {
    deepest: standing,
    authority,
    identity: identityOf(stats),
    queue: rest,
    hops: run.state.hops,
  };
}

/**
 * Whether this walk was asked to refuse shared ground at the route position it is standing at.
 *
 * The position, not the spelling: an allowed ancestor alias contributes no name of the caller's, so
 * everything reached through it stays above the caller's own ground and keeps ADR 0016's answer.
 */
function refusesSharedLevelOnRoute(run: WalkRun): boolean {
  const forbidden = run.policy?.noLinksAtRouteNameOrBelow;
  return (
    run.policy?.sharedLevelRefusedOnRoute === true &&
    forbidden !== undefined &&
    run.atRouteName !== undefined &&
    run.atRouteName >= forbidden
  );
}

/**
 * One link on the route: ADR 0016's own judgment, then the policy this caller asked for.
 *
 * A caller that CREATES entries in, or NARROWS the mode of, the ground it names refuses a link standing in that
 * ground, whatever the link's own ownership says: the bytes, or the mode change, would land on whatever the link
 * describes instead of where the caller's path says they go. Names above that line stay ADR 0016's to allow,
 * which is what keeps a system alias such as `/var` answering.
 */
function linkStep(
  run: WalkRun,
  link: string,
  stats: fs.BigIntStats,
  rest: readonly QueueName[],
): WalkState {
  const forbidden = run.policy?.noLinksAtRouteNameOrBelow;
  if (forbidden !== undefined && run.atRouteName !== undefined && run.atRouteName >= forbidden)
    refuseOn(run, link, 'planted_link');
  const exposure = untrustedLinkExposure(
    { uid: Number(stats.uid) },
    run.state.authority,
    run.trust,
  );
  if (exposure) refuseOn(run, link, exposure);
  if (run.state.hops >= MAX_SCRIPT_PATH_LINK_HOPS) refuseOn(run, link, 'link_loop_exceeded');
  // A relative target continues from the directory that HOLDS the link, and its components are queued RAW rather
  // than joined: ADR 0016. They are the link's names, not the caller's, and say so.
  const target = fs.readlinkSync(link);
  const home = path.isAbsolute(target) ? '/' : path.dirname(link);
  return standOn(
    run,
    home,
    [...pathComponents(target).map((name) => ({ name, route: false })), ...rest],
    run.state.hops + 1,
  );
}

/**
 * Says where the walk refused and throws. The ANSWer about position is recorded before the throw, because a
 * caller that repairs ground reads it and a caller that does not simply sees the failure.
 */
function refuseOn(run: WalkRun, ancestor: string, exposure: ScriptAncestryExposure): never {
  if (run.policy) run.policy.refusal.atRouteName = run.atRouteName;
  throw scriptAncestryFailure(run.destination, ancestor, exposure);
}

/** One queued name, and whether the caller spelled it or a link's target did. */
type QueueName = Readonly<{
  name: string;
  /** `true` for a name in the path the caller asked about, `false` for one a link's target brought in. */
  route: boolean;
}>;

/**
 * Stands the walk on `directory`, judged from this call's own `lstat` of it, or refuses it. A name come back
 * around through a `..` or an alias is judged again, and reaches the judgment it had on the first visit
 * (ADR 0016).
 */
function standOn(
  run: WalkRun,
  directory: string,
  queue: readonly QueueName[],
  hops: number,
): WalkState {
  const stats = lstatEntry(directory);
  if (stats === undefined || !stats.isDirectory()) refuseOn(run, directory, 'not_a_directory');
  const authority = directoryAuthority(stats);
  const exposure = untrustedAncestryExposure(authority, run.trust);
  if (exposure) refuseOn(run, directory, exposure);
  return { deepest: directory, authority, identity: identityOf(stats), queue, hops };
}

/** Owner and mode of the ENTRY one `lstat` answer describes. */
function directoryAuthority(stats: fs.BigIntStats): DirectoryAuthority {
  return { uid: Number(stats.uid), mode: Number(stats.mode) };
}

/** The names of `directory`, every `.` resolved away the way the kernel does. */
export function pathComponents(directory: string): string[] {
  return directory.split('/').filter((component) => component.length > 0 && component !== '.');
}

/**
 * How many link targets one walk expands before it refuses, kept BELOW the smallest limit the supported
 * kernels apply (macOS 32, Linux 40) so this rule reaches its own limit first and answers with its own reason.
 */
export const MAX_SCRIPT_PATH_LINK_HOPS = 30;

/**
 * Creates the tail the walk found missing, ONE LEVEL AT A TIME, inside the directory the walk judged, for the
 * one-name-at-a-time reason ADR 0016 states. A name that arrived since the walk looked is judged here, not
 * refused and not trusted, because two processes saving into the same new directory meet at that entry.
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
  const created = createLevelDirectory(level);
  // The `lstat` of the NAME, after the creation attempt, is the judgment either way: what this call made
  // and what arrived beside it are read the same way and judged by the same rule.
  const seen = judgedLevelEntry(destination, level, created);
  const authority = directoryAuthority(seen);
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) throw scriptAncestryFailure(destination, level, exposure);
  return created
    ? confirmCreatedLevel(destination, level, trust)
    : adoptStandingLevel(destination, level, authority, trust);
}

/**
 * Confirms the level this call just made still stands at the mode the masked CREATE gave it.
 *
 * The mode is proved by the creation, not by a `chmod` asked afterwards: {@link createLevelDirectory} masks
 * the umask, so the entry is born at {@link SCRIPT_DIR_MODE} and no name has to be said a mode in a window
 * another process could have put a link in. A level that answers loose here was re-moded AFTER this call made
 * it, by whoever can write this parent, and the answer is the refusal the judgment reports: the host gives
 * this rule no way to bind a mode change to the inode it created, so it does not guess that it holds one.
 */
function confirmCreatedLevel(
  destination: string,
  level: string,
  trust: ScriptDestinationTrust,
): string {
  const standing = lstatEntry(level);
  if (standing === undefined) {
    throw scriptAncestryFailure(destination, level, 'unreachable_parent');
  }
  const remaining = untrustedAncestryExposure(directoryAuthority(standing), trust);
  if (remaining) throw scriptAncestryFailure(destination, level, remaining);
  return level;
}

/**
 * Attempts one level CREATE at exactly {@link SCRIPT_DIR_MODE}, without saying a mode at a NAME afterwards.
 *
 * `mkdir` ANDs its mode with the umask, so the MASK is asked for the create itself. Two reasons, and the
 * second is the one that matters: a umask can take an OWNER bit away (umask 277 leaves 0500, a directory this
 * call cannot write into), and the only way to put such a mode right afterwards is a `chmod` at the name —
 * which follows a link planted in the moment between the create and the `chmod`. Under the mask the entry is
 * born at the mode, so no window opens. `umask` is process-wide, so it is set and restored with nothing in the
 * window that could yield.
 */
function createLevelDirectory(level: string): boolean {
  const previous = process.umask(CREATE_MASK);
  try {
    fs.mkdirSync(level, { mode: SCRIPT_DIR_MODE });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    process.umask(previous);
  }
}

/** The mask that leaves a {@link SCRIPT_DIR_MODE} create at exactly that mode under any host umask. */
const CREATE_MASK = 0o077;

/**
 * The entry standing at a level the walk said was missing, refused when it is not a directory.
 *
 * An entry that is not a directory is this call's own failure when this call created it, and another
 * process's move when this call found it already there: `entry_appeared` is the one exposure that says the
 * race was lost rather than the path misspelled.
 */
function judgedLevelEntry(destination: string, level: string, created: boolean): fs.BigIntStats {
  const seen = lstatEntry(level);
  if (seen === undefined || !seen.isDirectory()) {
    throw scriptAncestryFailure(destination, level, created ? 'not_a_directory' : 'entry_appeared');
  }
  return seen;
}

/**
 * Adopts a level somebody else made, refusing the ground where other local users could still add a name.
 *
 * This is the one place the destination rule asks that question of a directory it did not create: below the
 * walk, the entry that arrived beside this call is already the parent of what this call would put in it.
 */
function adoptStandingLevel(
  destination: string,
  level: string,
  authority: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): string {
  if (othersCreateEntriesIn(authority, trust)) {
    throw scriptAncestryFailure(destination, level, 'shared_parent');
  }
  return level;
}
