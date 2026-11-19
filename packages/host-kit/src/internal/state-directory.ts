/**
 * The daemon's own state directory (#4649): the one rule that says whether this process may keep its records
 * at a route, and the repair that makes its own level private when it can.
 *
 * A destination a caller names is the caller's own, and `script-destination.ts` judges it. A state directory is
 * the opposite case: the daemon picked it and writes there unasked. What it writes is only private if the WHOLE
 * route to it is, so the state rule asks the SAME walk the destination rule asks — full ancestry resolved one
 * name at a time from `/`, links where ADR 0016 allows them, so an allowed system alias such as `/var` to
 * `/private/var` still answers — and then asks one thing more: the directory an entry is created in must be
 * closed to entries from other local users, sticky bit or not, because here the daemon CREATES names of its own
 * choosing rather than passing through.
 *
 * Nothing here decides whether a daemon starts. Every refusal is an answer, and a repair is the narrowest action
 * that cannot follow a link. Levels above the state directory are judged and never repaired: the daemon does
 * not choose them, and a home directory is nobody's to tighten.
 *
 * `verified-file.ts` asks this rule about the directory it opens a record in; this module answers about ground
 * and never touches a record's bytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { identityOf, lstatEntry } from './atomic-publish.ts';
import { emitDiagnostic } from './diagnostics.ts';
import { spelledRouteStepsBackOut } from './path-resolution.ts';
import {
  othersCreateEntriesIn,
  pathComponents,
  SCRIPT_DIR_MODE,
  scriptTrust,
  walkSpelledParent,
  type ScriptDestinationTrust,
  type WalkGround,
  type WalkPolicy,
} from './script-destination.ts';
import {
  scriptAncestryReason,
  untrustedGroundWording,
  type ScriptAncestryExposure,
} from './script-destination-refusal.ts';

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
 * How a state chain fails: what the walk finds on the route, a spelling with no chain at all, ground this
 * process cannot read at all, and a record whose private mode this host would not carry.
 */
export type PrivateDirectoryExposure =
  | ScriptAncestryExposure
  | 'outside_state_dir'
  | 'state_dir_unreadable'
  | 'record_mode_unproven';

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
  // The SAME trust the script rule asks, asked from the owner of that rule. The state rule's extra strictness
  // — a sticky shared level refused on the route, sticky bit included — is the policy below and is asked of
  // every level of this route, so it is not paid for by loosening or tightening what the walk itself accepts.
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
  if (spelledRouteStepsBackOut(stateDir)) return undefined;
  return path.join(path.resolve(stateDir), ...names);
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
  if (exposure === 'record_mode_unproven') {
    return (
      'this host would not carry the private mode a state record is written at. Remove the record at that ' +
      'name, or keep the state directory on a filesystem that carries file modes.'
    );
  }
  return stateGroundWording[exposure] ?? untrustedGroundWording[exposure];
}
