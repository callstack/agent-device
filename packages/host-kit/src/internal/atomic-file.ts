import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
 * anything is staged, and it is judged again immediately before the link or rename. The file is created
 * private, because a recording is a transcript of what someone did on this machine.
 *
 * `parentIdentity` is what {@link publishDirectoryIdentity} returned for a parent the caller created or
 * checked before it staged this file.
 */
export function publishScriptFileSync(options: {
  destination: string;
  contents: string;
  mode?: number;
  publish?: AtomicPublishMode;
  parentIdentity?: string;
}): void {
  const mode = options.mode ?? 0o600;
  const expected =
    options.parentIdentity ?? publishDirectoryIdentity(path.dirname(options.destination));
  withAtomicPublishTempPathSync(options.destination, (temporaryPath) => {
    assertPrivateScriptDestination(options.destination, expected);
    fs.writeFileSync(temporaryPath, options.contents, { encoding: 'utf8', mode });
    assertPrivateScriptDestination(options.destination, expected);
    if (options.publish === 'link-exclusive') {
      fs.linkSync(temporaryPath, options.destination);
    } else {
      fs.renameSync(temporaryPath, options.destination);
    }
  });
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
  const temporaryPath = createAtomicPublishTempPath(destination);
  try {
    return publish(temporaryPath);
  } finally {
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

/** Returns the canonical same-directory temp path used by atomic publishers. */
function createAtomicPublishTempPath(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}-${crypto.randomUUID()}.tmp`,
  );
}

/** Identifies a temp path produced for a particular destination. */
export function isAtomicPublishTemporaryPath(value: unknown, destination: string): boolean {
  if (typeof value !== 'string') return false;
  if (path.dirname(value) !== path.dirname(destination)) return false;
  const name = path.basename(value);
  return name.startsWith(`.${path.basename(destination)}.`) && name.endsWith('.tmp');
}

/**
 * Refuses a script destination unless every directory on its fully resolved chain is one no other
 * non-root local user can change (#4565).
 *
 * Node exposes no `openat` or `renameat`, so a publisher cannot resolve a destination relative to a
 * directory handle. The window is closed by PERMISSIONS instead of by timing: once no other non-root
 * user can add or remove an entry in any directory on the chain, nobody can swap a component out or
 * plant one, so the path this rule judged is the path the publish reaches. Nothing here depends on when
 * the directory was judged, and no re-check is what makes the write safe.
 *
 * The existing prefix of the destination is resolved once, and every directory of that resolved chain
 * is judged, so a symbolic link's target is judged too: `/home/me/link` standing for a shared directory
 * is refused for the same reason that directory would be if the caller had spelled it out. Each
 * directory then has to satisfy:
 *
 * - It is owned by this user or by root. A directory another user owns is theirs to chmod, to empty, and
 *   to repopulate, whatever its mode says today, and both the sticky bit and the group bits shield other
 *   users FROM that owner rather than the reverse.
 * - Its mode opens its contents to nobody else. The sticky bit is the one exception, and only for
 *   passing THROUGH a directory: it stops anyone but an entry's owner or root from removing or replacing
 *   that entry, which is how macOS `/tmp` and `/var` stay usable. It cannot refuse a NEW entry by name,
 *   so nothing may be created inside a directory others can add entries to; that is asked separately.
 * - A symbolic link the path passes through is one others could not have planted or swapped: in a
 *   directory where they can add entries, it stands there only because the sticky bit and its owner
 *   hold it in place.
 *
 * A group-writable directory this user owns stays acceptable when its group is this user's own private
 * group, the shape Ubuntu and Debian give every home directory. {@link privateGroupId} says what that
 * takes to establish, and what it cannot.
 *
 * A component that exists and is neither a directory nor a link is left alone: the filesystem refuses a
 * publish through it. On Windows, access is an ACL rather than a mode, so this is a no-op there.
 *
 * `parentIdentity` is what {@link publishDirectoryIdentity} returned for the parent the caller created
 * or checked before it staged this file. The rule above already excludes anyone who could swap that
 * parent, so the comparison is defense in depth against a host whose ownership or modes moved meanwhile;
 * it is not what closes the window.
 */
export function assertPrivateScriptDestination(destination: string, parentIdentity?: string): void {
  if (process.platform === 'win32') return;
  const parent = spelledParent(destination);
  if (parentIdentity !== undefined && publishDirectoryIdentity(parent) !== parentIdentity) {
    throw scriptAncestryFailure(destination, parent, 'parent_replaced');
  }
  const trust = readScriptTrust();
  assertNoPlantedLink(destination, parent, trust);
  const traversed = traversedDirectories(parent);
  if (traversed.paths.length === 0) return;
  for (const directory of traversed.paths) {
    const stats = statDirectoryChain(directory);
    if (!stats) continue;
    const exposure = untrustedAncestryExposure(stats, trust);
    if (exposure) throw scriptAncestryFailure(destination, directory, exposure);
  }
  // The script entry is created inside the deepest directory that exists, or below it through
  // directories that do not exist yet. Where other local users can add entries, one of them can add
  // this entry first and the recording is theirs, so the creation has to be refused.
  const deepest = statDirectoryChain(traversed.deepest);
  if (deepest && othersCreateEntriesIn(deepest, trust)) {
    throw scriptAncestryFailure(destination, traversed.deepest, 'shared_parent');
  }
}

/** Link hops one destination walk expands before it stops, in step with the kernel's own limit. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Every directory the kernel traverses to reach `parent`, judged nearest-first, without duplicates, and
 * the deepest one that exists.
 *
 * Resolving only the deepest existing ancestor is not enough, and neither is one `realpath` of a path
 * that runs through links:
 *
 * - A component that is a plain directory is traversed as it stands, so a link inside it can lead
 *   anywhere, and the directories above that plain component are reached by the publish even though the
 *   final chain looks entirely private: `<root>/shared` at 0777 with `<root>/shared/mine` at 0700 and
 *   `mine/rec` a link to a private directory names only trusted directories at its destination, while
 *   another local user owns the ground `mine` and `rec` stand on and can rename `mine` aside. So EVERY
 *   existing prefix of the spelled path is resolved, and the chain under each resolution is judged.
 * - Where one link leads into another, `realpathSync` answers with the LAST target and names none of the
 *   directories stepped through on the way: `~/rec -> /srv/team/relay -> ~/chosen` reaches a private
 *   directory, and the team ground `relay` stands on never appears in the answer, though any teammate
 *   can swap that link for a target of their own. So a link hop also judges the directory holding its
 *   target, and the walk continues into the target.
 */
function traversedDirectories(
  parent: string,
): Readonly<{ paths: readonly string[]; deepest: string }> {
  const seen = new Set<string>();
  const paths: string[] = [];
  let deepest: string | undefined;
  for (const prefix of directoryChain(parent)) {
    let current = prefix;
    // Each hop replaces one link with its target, so a link cycle cannot run the walk forever. The
    // operating system applies a limit of the same order and refuses the publish when it is exceeded.
    for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
      const stats = lstatIfPresentSync(current);
      if (stats === undefined) break;
      if (!stats.isSymbolicLink()) {
        const real = resolvedDirectory(current);
        if (real === undefined) break;
        deepest ??= real;
        for (const ancestor of directoryChain(real)) {
          if (seen.has(ancestor)) continue;
          seen.add(ancestor);
          paths.push(ancestor);
        }
        break;
      }
      const target = linkTarget(current);
      // The kernel steps INTO the directory the target names, so that directory and everything above it
      // are traversed whatever this link eventually resolves to.
      const home = resolvedDirectory(parentDirectory(target));
      if (home !== undefined) {
        for (const ancestor of directoryChain(home)) {
          if (seen.has(ancestor)) continue;
          seen.add(ancestor);
          paths.push(ancestor);
        }
      }
      current = target;
    }
  }
  return { paths, deepest: deepest ?? parent };
}

/** Where a symbolic link points, made absolute the way the kernel reads it. */
function linkTarget(link: string): string {
  const target = fs.readlinkSync(link);
  return path.isAbsolute(target) ? target : `${parentDirectory(link)}/${target}`;
}

/** The directory `path` names once every link in it is expanded, or `undefined` when it is absent. */
function resolvedDirectory(pathname: string): string | undefined {
  if (lstatIfPresentSync(pathname) === undefined) return undefined;
  try {
    const real = fs.realpathSync(pathname);
    return statDirectoryChain(real) ? real : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The parent of `destination` as it was spelled, made absolute but never normalized.
 *
 * `path.resolve` folds a `..` away, which is the one simplification this rule may not make: the kernel
 * does not make it either, so `.../work/../x` lands an entry beside the target of a link named `work`.
 * The chain that walk produces is what gets judged.
 */
function spelledParent(destination: string): string {
  if (path.isAbsolute(destination)) return parentDirectory(destination);
  // A relative destination reaches the filesystem through the working directory, the same way
  // `path.resolve` names it, and the walk above is what the kernel performs from there.
  return parentDirectory(path.resolve(destination));
}

/**
 * Refuses a symbolic link on the spelled path that another local user could have put there, or could
 * replace. The link's target is judged through the resolved chain, so this only asks whether the link
 * itself is stable:
 *
 * - In a directory others cannot add entries in, a link nobody but this user or root can write is not
 *   something they can plant or swap.
 * - In a directory others CAN add entries in, the sticky bit is what protects an entry that already
 *   exists: it stops anyone but the entry's owner or root from removing or replacing it. Without the
 *   sticky bit, any of them can unlink this link and plant one pointing wherever they choose.
 */
function assertNoPlantedLink(
  destination: string,
  parent: string,
  trust: ScriptDestinationTrust,
): void {
  for (const ancestor of directoryChain(parent)) {
    const link = lstatIfPresentSync(ancestor);
    if (!link?.isSymbolicLink()) continue;
    const home = lstatIfPresentSync(parentDirectory(ancestor));
    if (!home) continue;
    const exposure = untrustedLinkExposure(
      { uid: link.uid },
      { uid: home.uid, gid: home.gid, mode: home.mode },
      trust,
    );
    if (exposure) throw scriptAncestryFailure(destination, ancestor, exposure);
  }
}

/**
 * One directory's identity on its filesystem, for a caller that must publish into the same one it
 * created or checked. `undefined` when the directory is absent or is not a directory.
 */
export function publishDirectoryIdentity(directory: string): string | undefined {
  if (process.platform === 'win32') return 'windows';
  const stats = statDirectoryChain(directory);
  return stats ? `${stats.dev}:${stats.ino}` : undefined;
}

/** The group and passwd records the private-group exception reads, in `/etc/group` field order. */
type HostGroupDatabase = Readonly<{
  /** `undefined` when the file could not be read, which is not the same as a file with no records. */
  groups: readonly string[] | undefined;
  passwd: readonly string[] | undefined;
}>;

/**
 * The single group the private-group exception admits, or `undefined` when nothing was established.
 *
 * Ubuntu and Debian create one group per user, named after them, and set up that user's home directory
 * with it, often group-writable and owned by that user. Such a home is shared with no other local user,
 * so it stays a valid script destination. Every other group stays outside the exception, and the rule
 * fails closed wherever completeness cannot be established:
 *
 * - Both database files must have been READ. An unreadable file is not an empty one, and an empty
 *   member list proves nothing.
 * - The gid must be the one this process holds as its PRIMARY group, which `getgid` answers from the
 *   kernel rather than from a file, and at least one record carrying that gid must bear this user's name.
 * - EVERY record carrying that gid is read, because a directory group-writable by gid 1000 is writable
 *   by the members of each group holding the number, however they are named: `ada:x:1000:` beside
 *   `team:x:1000:grace` reaches grace. Any of them naming a member who is neither this user nor root
 *   ends the claim, without lookup or forgiveness — macOS lists only part of `staff` in `/etc/group`
 *   while every local user holds it.
 * - No other passwd record may hold this gid as its primary group, and the caller's own record must
 *   exist there with this uid and this gid.
 *
 * What this cannot establish, stated plainly because it cuts BOTH ways: the two files are only this
 * machine's own view. A name service (LDAP, an NSS module) can hold a member of this gid, or a second
 * group with the number, that never appears in `/etc/passwd` or `/etc/group`. Such a host can be
 * refused a group-writable directory it genuinely owns, and it can also be ACCEPTED for one the name
 * service has opened to someone else — this rule cannot see that member and so cannot refuse it. The
 * caller's answer on a name-service host is a directory only they can write, at any mode.
 */
export function privateGroupId(
  database: HostGroupDatabase,
  current: Readonly<{ uid: number | undefined; gid: number | undefined; name: string | undefined }>,
): number | undefined {
  const { uid, gid, name } = current;
  if (uid === undefined || gid === undefined || name === undefined) return undefined;
  if (!database.groups || !database.passwd) return undefined;
  const own = database.passwd.find((line) => line.split(':')[0] === name);
  if (!own) return undefined;
  const [, , ownUid, ownGid] = own.split(':');
  if (Number(ownUid) !== uid || Number(ownGid) !== gid) return undefined;
  // EVERY record carrying this gid decides together: a directory group-writable by gid 1000 is writable
  // by the members of each of them, however they are named. A group named after the user buys the
  // exception only while no other record sharing the number reaches another user.
  let namedForUser = false;
  for (const line of database.groups) {
    const [groupName, , rawGid, rawMembers = ''] = line.split(':');
    const recordGid = Number(rawGid);
    if (rawGid === '' || !Number.isInteger(recordGid) || recordGid !== gid) continue;
    if (groupName === name) namedForUser = true;
    const members = rawMembers.split(',').filter((member) => member.length > 0);
    if (members.some((member) => !memberIsTrusted(member, database, name))) return undefined;
  }
  if (!namedForUser) return undefined;
  const sharesPrimary = database.passwd.some((line) => {
    const [other, , rawOtherUid, rawOtherGid] = line.split(':');
    return other !== name && Number(rawOtherGid) === gid && Number(rawOtherUid) !== 0;
  });
  return sharesPrimary ? undefined : gid;
}

/** Whether a member of a candidate private group is the user or root, the two accounts the rule trusts. */
function memberIsTrusted(member: string, database: HostGroupDatabase, name: string): boolean {
  if (member === name) return true;
  const record = database.passwd?.find((line) => line.split(':')[0] === member);
  return record !== undefined && Number(record.split(':')[2]) === 0;
}

/** This process's identity and the private group its host databases establish, if any. */
function readScriptTrust(): ScriptDestinationTrust {
  return {
    uid: process.getuid?.() ?? -1,
    privateGid: privateGroupId(
      { groups: readSystemFile('/etc/group'), passwd: readSystemFile('/etc/passwd') },
      { uid: process.getuid?.(), gid: process.getgid?.(), name: readCurrentUser() },
    ),
  };
}

function readCurrentUser(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

/** Every directory from `directory` up to the filesystem root, nearest first. */
function directoryChain(directory: string): string[] {
  const chain: string[] = [];
  let current = directory;
  for (;;) {
    chain.push(current);
    const parent = parentDirectory(current);
    if (parent === current) return chain;
    current = parent;
  }
}

/**
 * The parent of `directory`, as the kernel sees it, or the same path when there is no parent.
 *
 * `path.dirname` is not usable here: it normalizes, so it folds a `..` segment away. That is the one
 * simplification this rule may not make. Where `work` is a symbolic link, `.../work/../x` is a real
 * path that lands beside the link's TARGET, so the rule has to see `.../work` in the chain and judge
 * the link that stands there. Only a trailing separator is dropped, in linear time.
 */
function parentDirectory(directory: string): string {
  const trimmed = directory.endsWith('/') ? directory.slice(0, -1) : directory;
  const separator = trimmed.lastIndexOf('/');
  if (separator < 0) return trimmed;
  return separator === 0 ? '/' : trimmed.slice(0, separator);
}

/**
 * The two ways a directory can be unsafe for a destination: someone else can change what is in it, or
 * someone else can create the entry the destination names.
 *
 * `foreign_owned` — some other user owns it and can chmod, empty, or repopulate it whatever its mode.
 * `world_writable` / `shared_group_writable` — its mode opens its contents to others.
 * `shared_parent` — nobody else can change what is in it today, but they can add the missing entry.
 * `planted_link` — a symbolic link someone else could have put in place of a directory.
 * `parent_replaced` — the directory the caller staged against is not the one it was.
 */
export type ScriptAncestryExposure =
  | 'foreign_owned'
  | 'world_writable'
  | 'shared_group_writable'
  | 'shared_parent'
  | 'planted_link'
  | 'parent_replaced';

/** What this process can rely on when it judges a directory: its identity and its private group. */
export type ScriptDestinationTrust = Readonly<{
  uid: number;
  privateGid: number | undefined;
}>;

/** The fields of a directory the ancestry rule reads, so the decision is testable without a filesystem. */
export type DirectoryAuthority = Readonly<{ uid: number; gid: number; mode: number }>;

/**
 * Whether this directory is one this user can rely on a destination being inside of, and why not if it
 * is not.
 *
 * Ownership is asked first: a directory another user owns is theirs to chmod, to empty, and to
 * repopulate whatever its mode says today, and no race is needed to do it. Then the mode, because
 * group- or other-writable contents are open to those users directly. The sticky bit is the one mode
 * exception, and it is sound only for PASSING THROUGH a directory: it stops anyone but an entry's owner
 * or root from removing or replacing that entry, so the entries already on the path hold. It cannot
 * refuse a NEW entry by name, so {@link othersCreateEntriesIn} is asked separately before anything is
 * created inside.
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
 * A directory somebody else owns counts: they can create, rename, or replace any entry in it whatever
 * its mode says, sticky bit included, since both of those protect other people's entries from them, not
 * their own. The sticky bit is otherwise deliberately not consulted here — it cannot refuse a NEW entry
 * by name.
 */
export function othersCreateEntriesIn(
  directory: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): boolean {
  if (directory.uid !== 0 && directory.uid !== trust.uid) return true;
  if (directory.mode & 0o002) return true;
  return Boolean(directory.mode & 0o020) && directory.gid !== trust.privateGid;
}

/** The fields of a symbolic link the ancestry rule reads. */
export type LinkAuthority = Readonly<{ uid: number }>;

/**
 * Whether a symbolic link on the path is one another local user could have put there, or could replace,
 * and whose target is therefore theirs to choose.
 *
 * Where nobody but this user or root can add entries, a link cannot appear or change behind this rule.
 * Where others CAN add entries, the sticky bit is the only thing holding an existing entry in place: it
 * stops anyone but the entry's owner or root from unlinking and replacing it, so a link this user or root
 * owns stands, and one anybody else owns does not — it may be theirs, and without the sticky bit any of
 * them can swap it for one pointing wherever they like.
 *
 * A component the path steps back over with `..` is asked as a directory rather than as a link: there
 * the caller is not publishing through it, only walking across it, and the directory it lands in is
 * judged on its own.
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

function scriptAncestryFailure(
  destination: string,
  ancestor: string,
  exposure: ScriptAncestryExposure,
): AppError {
  const replaced = exposure === 'parent_replaced';
  return new AppError(
    'COMMAND_FAILED',
    replaced
      ? `The directory for ${destination} changed while the script was staged, so the script was not saved.`
      : `Refusing to save the script under ${ancestor}: another local user owns or can write that part of the path.`,
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

function readSystemFile(file: string): string[] | undefined {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return undefined;
  }
}

/** `lstat` where absence is `undefined`; any other failure propagates. */
function lstatIfPresentSync(pathname: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
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

function lstatIfPresent(pathname: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
