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
 *   to repopulate, whatever its mode says today.
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
  const parent = path.dirname(path.resolve(destination));
  if (parentIdentity !== undefined && publishDirectoryIdentity(parent) !== parentIdentity) {
    throw scriptAncestryFailure(destination, parent, 'parent_replaced');
  }
  const trust = readScriptTrust();
  assertNoPlantedLink(destination, parent, trust);
  const existing = deepestExistingDirectory(parent);
  if (existing.real === undefined) return;
  const chain = directoryChain(existing.real);
  for (const ancestor of chain) {
    const stats = statDirectoryChain(ancestor);
    if (!stats) continue;
    const exposure = untrustedAncestryExposure(stats, trust);
    if (exposure) throw scriptAncestryFailure(destination, ancestor, exposure);
  }
  // The script entry is created inside the deepest directory that exists, or below it through
  // directories that do not exist yet. Where other local users can add entries, one of them can add
  // this entry first and the recording is theirs, so the creation has to be refused.
  const deepest = statDirectoryChain(existing.real);
  if (deepest && othersCreateEntriesIn(deepest, trust)) {
    throw scriptAncestryFailure(destination, existing.real, 'shared_parent');
  }
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
    const home = lstatIfPresentSync(path.dirname(ancestor));
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
 * The real path of the deepest directory `directory` names or leads to, or `undefined` when nothing of it
 * exists to judge. A component that exists but resolves to nothing (a dangling link) is stepped over like
 * one that is absent, so the walk never stops with nothing checked.
 */
function deepestExistingDirectory(directory: string): Readonly<{ real: string | undefined }> {
  let current = directory;
  for (;;) {
    if (lstatIfPresentSync(current) !== undefined) {
      try {
        const real = fs.realpathSync(current);
        if (statDirectoryChain(real)) return { real };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return { real: undefined };
    current = parent;
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
 * - The group must be the one this process holds as its PRIMARY group, which `getgid` answers from the
 *   kernel rather than from a file, and it must carry this user's name.
 * - The group's own member list may name nobody but this user. macOS lists only part of `staff` in
 *   `/etc/group` while every local user holds it, so a name that is not this user's ends the claim
 *   rather than being looked up and forgiven.
 * - No other record in the passwd file may hold this group as its primary group, and the caller's own
 *   record must exist there with this uid and this gid.
 *
 * What this cannot establish: a name service (LDAP, NSS modules) can add a user whose primary group is
 * this gid without that user ever appearing in `/etc/passwd`. A host configured that way can still be
 * refused a group-writable destination it appears to own, which is the residual limitation the
 * documentation names; the caller's fallback is a directory only they can write.
 */
export function privateGroupId(
  database: HostGroupDatabase,
  current: Readonly<{ uid: number | undefined; gid: number | undefined; name: string | undefined }>,
): number | undefined {
  const { uid, gid, name } = current;
  if (uid === undefined || gid === undefined || name === undefined) return undefined;
  if (!database.groups || !database.passwd) return undefined;
  const record = database.groups.find((line) => line.split(':')[0] === name);
  if (!record) return undefined;
  const [, , rawGid, rawMembers = ''] = record.split(':');
  const privateGid = Number(rawGid);
  if (!Number.isInteger(privateGid) || privateGid !== gid) return undefined;
  const members = rawMembers.split(',').filter((member) => member.length > 0);
  if (members.some((member) => member !== name)) return undefined;
  const own = database.passwd.find((line) => line.split(':')[0] === name);
  if (!own) return undefined;
  const [, , ownUid, ownGid] = own.split(':');
  if (Number(ownUid) !== uid || Number(ownGid) !== gid) return undefined;
  const sharesPrimary = database.passwd.some((line) => {
    const [other, , , otherGid] = line.split(':');
    return other !== name && Number(otherGid) === gid;
  });
  return sharesPrimary ? undefined : gid;
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
    const parent = path.dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
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
 * directory below it, becomes theirs. The sticky bit is deliberately not consulted: it protects entries
 * that already exist and cannot refuse a new one.
 */
export function othersCreateEntriesIn(
  directory: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): boolean {
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
