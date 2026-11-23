import fs from 'node:fs';
import path from 'node:path';
import { publishFileSync, type AtomicPublishMode } from './atomic-publish.ts';
import {
  entryNameOrRefuse,
  requireWindowsScriptVolume,
  scriptEntryNameOrRefuse,
} from './entry-name.ts';
import { hostPathRules } from '../path-resolution.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  scriptAncestryFailure,
  scriptAncestryReason,
  type ScriptAncestryExposure,
} from './script-destination-refusal.ts';

/**
 * What this process may rely on when it judges ground: who it is, as the kernel answers. The rule reads no
 * account database, so the answer does not depend on which name services run (ADR 0016). Every judgment below
 * decides over the fields of one `lstat`, so each is testable on its values.
 */
export type ScriptDestinationTrust = Readonly<{
  uid: number;
  privateAncestry?: boolean;
  /** Set for a private root: its ancestry refuses a group-writable directory this user owns too. */
  closedToOwnGroup?: boolean;
}>;

/**
 * How strictly a caller's destination is judged. `privateAncestry` is for executable state, such as the Swift
 * helper cache: no directory the walk traverses may be group- or world-writable, sticky or not, because a
 * sticky shared directory lets another user claim a name a cleaner removed (ADR 0016).
 */
export type ScriptDestinationOptions = Readonly<{ privateAncestry?: boolean }>;

function scriptTrust(options: ScriptDestinationOptions): ScriptDestinationTrust {
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
  if (groupAddsEntriesIn(directory, trust)) return 'shared_group_writable';
  return undefined;
}

/**
 * Whether the group's write bit counts as opening `directory` to other accounts. The script rule accepts the
 * group of a directory this non-root user owns as that owner's responsibility; it accepts no group on a
 * directory root owns, and executable state and a private root accept no group at all (ADR 0016).
 */
function groupAddsEntriesIn(directory: DirectoryAuthority, trust: ScriptDestinationTrust): boolean {
  if (!(directory.mode & 0o020)) return false;
  if (trust.privateAncestry || trust.closedToOwnGroup) return true;
  return directory.uid === 0 || directory.uid !== trust.uid;
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
  return groupAddsEntriesIn(directory, trust);
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
  contents: string | Uint8Array;
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
 * A directory a publish creates holds private recordings, so it is created owner-only under every umask — the
 * shared-checkout umask 002 would otherwise leave it 0775, open to its group.
 */
const SCRIPT_DIR_MODE = 0o700;

/**
 * Readies a script destination and reports the PHYSICAL directory to create the entry in, in ADR 0016's order:
 * walk, refuse before anything is created, create what is missing, walk the completed chain again, answer.
 */
export function prepareScriptDestination(
  destination: string,
  options: ScriptDestinationOptions = {},
): ScriptDestination {
  if (process.platform === 'win32') {
    return windowsScriptDestination(destination);
  }
  // A relative spelling is refused first, whatever its last segment, because that is what makes it unjudgeable.
  const spelled = spelledParent(destination);
  const name = scriptEntryNameOrRefuse(destination);
  const trust = scriptTrust(options);
  // The walk answers the COMPLETED chain, so this is the one place the CREATION question is asked: below the
  // walk the missing directories are this call's own to create, and asking it before creation would refuse
  // `mkdir -p <sticky shared>/recordings`, where those levels are 0700 of this call's own (ADR 0016).
  const arrived = walkSpelledParent(spelled, destination, trust, true);
  if (othersCreateEntriesIn(arrived.authority, trust)) {
    throw scriptAncestryFailure(destination, arrived.deepest, 'shared_parent');
  }
  return authorizedEntry(arrived.deepest, name);
}

function windowsScriptDestination(destination: string): ScriptDestination {
  const rules = path.win32;
  const root = requireWindowsScriptVolume(destination, destination);
  const name = entryNameOrRefuse(destination, rules);
  const directory = rules.dirname(rules.normalize(destination));
  requireWindowsScriptDirectory(destination, root);
  if (directory !== root) createWindowsScriptParents(destination, root, directory);
  return authorizedEntry(directory, name);
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
function isWindowsShareUnavailable(file: string, error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    /^[\\/]{2}/.test(file) &&
    (error as NodeJS.ErrnoException | undefined)?.code === 'ECONNRESET'
  );
}

function authorizedEntry(directory: string, name: string): ScriptDestination {
  return { directory, name, entry: hostPathRules().join(directory, name) };
}

/**
 * The entry a script is created as: the PHYSICAL directory the rule judged and the validated name. `entry` is
 * the one path a publisher creates.
 */
export type ScriptDestination = Readonly<{
  directory: string;
  name: string;
  entry: string;
}>;

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

/** Where the walk stands: a judged directory and the names left to resolve. */
type WalkState = Readonly<{
  deepest: string;
  authority: DirectoryAuthority;
  /** Path components left to resolve, nearest first. */
  queue: readonly string[];
  /** Link targets expanded so far. */
  hops: number;
}>;

/**
 * The ground a walk answered: the PHYSICAL directory the entry is created in, with the authority it was judged
 * under, so the caller never asks the host about ground the walk already read.
 */
type WalkGround = Readonly<{
  deepest: string;
  authority: DirectoryAuthority;
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
 */
function walkSpelledParent(
  parent: string,
  destination: string,
  trust: ScriptDestinationTrust,
  create: boolean,
): WalkGround {
  const refuse: RefuseAncestor = (ancestor, exposure, callerOwnsAncestor) => {
    throw scriptAncestryFailure(destination, ancestor, exposure, callerOwnsAncestor);
  };
  let state = standOn('/', pathComponents(parent), trust, 0, refuse);
  let created = false;
  // Every step consumes a component, and every link hop counts against a fixed limit, so this ends.
  for (;;) {
    const [component, ...rest] = state.queue;
    // The only ending that ARRIVES: an empty queue, every name the parent spelled resolved and judged.
    if (component === undefined) {
      return { deepest: state.deepest, authority: state.authority };
    }
    // `..` is the parent of the directory PHYSICALLY stood in, not of the spelling: where `work` is a link,
    // `.../work/../x` steps back from the link's target and lands beside it.
    if (component === '..') {
      state = standOn(path.dirname(state.deepest), rest, trust, state.hops, refuse);
      continue;
    }
    const step = stepIntoEntry(state, component, rest, trust, refuse);
    if (step.ended === 'short') {
      const { deepest, missing, unresolvable } = step;
      // Nothing stands below here. A caller that creates makes that tail and is judged again; a step back out
      // of a directory that is not there is something no amount of creating resolves.
      if (!create || created || unresolvable) {
        throw scriptAncestryFailure(
          destination,
          deepest,
          unresolvable ? 'unresolvable_parent' : 'unreachable_parent',
        );
      }
      createMissingLevels(destination, deepest, missing, trust);
      created = true;
      state = standOn('/', pathComponents(parent), trust, 0, refuse);
      continue;
    }
    state = step.state;
  }
}

/** Refuses the walk at `ancestor`; a directory judgment also says whether the caller owns it. */
type RefuseAncestor = (
  ancestor: string,
  exposure: ScriptAncestryExposure,
  callerOwnsAncestor?: boolean,
) => never;

/** Where one named entry leaves the walk: standing on a judged directory, or short of the chain. */
type EntryStep =
  | Readonly<{ ended: 'stand'; state: WalkState }>
  | (ShortTail & Readonly<{ ended: 'short' }>);

/**
 * Resolves one named entry inside the directory the walk stands in, judged by this call's own `lstat` of the
 * NAME (ADR 0016).
 */
function stepIntoEntry(
  state: WalkState,
  component: string,
  rest: readonly string[],
  trust: ScriptDestinationTrust,
  refuse: RefuseAncestor,
): EntryStep {
  const entry = path.join(state.deepest, component);
  const stats = lstatEntry(entry);
  if (stats === undefined) {
    return {
      ended: 'short',
      deepest: state.deepest,
      missing: [component, ...rest],
      unresolvable: rest.includes('..'),
    };
  }
  if (stats.isSymbolicLink()) return hopThroughLink(state, entry, stats, rest, trust, refuse);
  if (!stats.isDirectory()) refuse(entry, 'not_a_directory');
  const authority = directoryAuthority(stats);
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) refuse(entry, exposure, authority.uid === trust.uid);
  return {
    ended: 'stand',
    state: { deepest: entry, authority, queue: rest, hops: state.hops },
  };
}

/** One hop: the link is judged where it stands, and its target's components enter the queue. */
function hopThroughLink(
  state: WalkState,
  link: string,
  stats: fs.BigIntStats,
  rest: readonly string[],
  trust: ScriptDestinationTrust,
  refuse: RefuseAncestor,
): EntryStep {
  const exposure = untrustedLinkExposure({ uid: Number(stats.uid) }, state.authority, trust);
  if (exposure) refuse(link, exposure);
  if (state.hops >= MAX_SCRIPT_PATH_LINK_HOPS) refuse(link, 'link_loop_exceeded');
  const target = fs.readlinkSync(link);
  // A relative target continues from the directory that HOLDS the link, and its components are queued RAW
  // rather than joined: ADR 0016.
  const home = path.isAbsolute(target) ? '/' : path.dirname(link);
  return {
    ended: 'stand',
    state: standOn(home, [...pathComponents(target), ...rest], trust, state.hops + 1, refuse),
  };
}

/**
 * Stands the walk on `directory`, judged from this call's own `lstat` of it, or refuses it. A name come back
 * around through a `..` or an alias is judged again, and reaches the judgment it had on the first visit
 * (ADR 0016).
 */
function standOn(
  directory: string,
  queue: readonly string[],
  trust: ScriptDestinationTrust,
  hops: number,
  refuse: RefuseAncestor,
): WalkState {
  const stats = lstatEntry(directory);
  if (stats === undefined || !stats.isDirectory()) refuse(directory, 'not_a_directory');
  const authority = directoryAuthority(stats);
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) refuse(directory, exposure, authority.uid === trust.uid);
  return { deepest: directory, authority, queue, hops };
}

/** Owner and mode of the ENTRY one `lstat` answer describes. */
function directoryAuthority(stats: fs.BigIntStats): DirectoryAuthority {
  return { uid: Number(stats.uid), mode: Number(stats.mode) };
}

/** The only lookup this rule makes: `lstat` with bigint ids, absence as `undefined`. */
function lstatEntry(pathname: string): fs.BigIntStats | undefined {
  return fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
}

/** The names of `directory`, every `.` resolved away the way the kernel does. */
function pathComponents(directory: string): string[] {
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
  if (exposure) {
    throw scriptAncestryFailure(destination, level, exposure, authority.uid === trust.uid);
  }
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

/** Never all of a bare `/`. On POSIX `\` is a file-name character: `state\` is part of a name to judge. */
const TRAILING_HOST_SEPARATORS = process.platform === 'win32' ? /(?<=.)[\\/]+$/ : /(?<=.)\/+$/;

/**
 * Admits a private root before an operation's first use of it: every ancestor through
 * {@link walkSpelledParent}, then the root's OWN name, then each managed name below it. `establish` creates a
 * missing root at 0700 and `repair` creates nothing; both close a directory the umask left open (#4649).
 * The ancestry is judged BEFORE the root's own bits are closed, and `chmod` follows links, so that order is
 * what keeps a planted link's target out of reach of the mode change.
 */
export type PrivateRootAdmission =
  | Readonly<{ status: 'admitted' }>
  | Readonly<{ status: 'refused'; component: string; exposure: ScriptAncestryExposure }>;

export function admitPrivateRoot(options: {
  rootPath: string;
  mode: 'repair' | 'establish';
  /** Names below the root this caller traverses, judged by the same rule. */
  managedDirs?: readonly string[];
}): PrivateRootAdmission {
  const trust: ScriptDestinationTrust = { ...scriptTrust({}), closedToOwnGroup: true };
  const root = options.rootPath.replace(TRAILING_HOST_SEPARATORS, '');
  if (!path.isAbsolute(root))
    return { status: 'refused', component: root, exposure: 'relative_destination' };
  const create = options.mode === 'establish';
  try {
    const parent = walkSpelledParent(path.dirname(root), root, trust, create);
    if (create && !lstatEntry(root))
      createMissingLevel(root, parent.deepest, path.basename(root), trust);
    for (const directory of [
      root,
      ...(options.managedDirs ?? []).map((name) => path.join(root, name)),
    ]) {
      const fault = admitDirectory(directory, trust);
      if (fault) return { status: 'refused', component: directory, exposure: fault };
    }
  } catch (error) {
    return verdictForAncestryFault(error, create);
  }
  return { status: 'admitted' };
}

/** The root rule of one name. Absence is no fault: `repair` creates nothing. */
function admitDirectory(
  directory: string,
  trust: ScriptDestinationTrust,
): ScriptAncestryExposure | undefined {
  const seen = lstatEntry(directory);
  if (seen === undefined) return undefined;
  if (seen.isSymbolicLink()) return 'planted_link';
  if (!seen.isDirectory()) return 'not_a_directory';
  if (Number(seen.uid) !== trust.uid) return 'foreign_owned';
  if (!(Number(seen.mode) & 0o077)) return undefined;
  // Only a change the host refuses for the directory's OWN owner is a fault (#4649).
  try {
    fs.chmodSync(directory, SCRIPT_DIR_MODE);
  } catch {
    return 'not_private';
  }
  return undefined;
}

function verdictForAncestryFault(error: unknown, create: boolean): PrivateRootAdmission {
  if (scriptAncestryReason(error) === undefined) throw error;
  const { ancestor, exposure } = (error as AppError).details as Readonly<{
    ancestor: string;
    exposure: ScriptAncestryExposure;
  }>;
  // A route that is not there yet is an absent root, not an unsafe one, to a caller that creates nothing.
  if (!create && (exposure === 'unreachable_parent' || exposure === 'unresolvable_parent'))
    return { status: 'admitted' };
  return { status: 'refused', component: ancestor, exposure };
}
