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
 * anything is written, and it is checked again immediately before the link or rename, so a directory
 * swapped in by another local user while the file was staged never receives the script.
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
  const expected =
    options.parentIdentity ?? publishDirectoryIdentity(path.dirname(options.destination));
  withAtomicPublishTempPathSync(options.destination, (temporaryPath) => {
    assertPrivateScriptDestination(options.destination, expected);
    fs.writeFileSync(
      temporaryPath,
      options.contents,
      options.mode === undefined ? 'utf8' : { encoding: 'utf8', mode: options.mode },
    );
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
 * Refuses a script destination when another local user can write a directory on the way to it (#4565).
 *
 * Node exposes no `openat` or `renameat`, so a publisher cannot resolve a destination relative to a
 * directory handle. What remains is to refuse every chain a second local user can act inside: a
 * directory they can write is one where they can replace a component of this path, or create one before
 * this client does, so the script lands where they choose, or they take it from a directory they own.
 *
 * The rule reads each component with `lstat`, so a symbolic link is judged as the link it is and is
 * never mistaken for the directory its target names:
 *
 * - A component's mode decides. The sticky bit cancels the exposure: it stops anyone but an entry's
 *   owner or root from removing or replacing that entry, which is how a shared team directory is made
 *   safe, and why the hint names it.
 * - Otherwise a component writable by anyone other than this user is refused, except a group-writable
 *   one whose group is this user's own private group: Ubuntu and Debian set up every home directory
 *   that way, often group-writable, and those have to stay usable.
 * - A symbolic link whose own directory others can create entries in is refused whatever it points at:
 *   it may be one they planted, and its target is theirs to choose. The sticky bit does not help here,
 *   because it guards entries that already exist.
 *
 * An absent or non-directory component is left alone: the filesystem refuses a publish through it. On
 * Windows, access is an ACL rather than a mode, so this is a no-op there.
 *
 * `parentIdentity` is what {@link publishDirectoryIdentity} returned for the parent the caller created
 * or checked before it staged this file. Whoever owns a directory above it can open that directory to
 * others, swap the parent for one of their own while the file is staged, and close it again, and only
 * the identity catches that.
 */
export function assertPrivateScriptDestination(destination: string, parentIdentity?: string): void {
  if (process.platform === 'win32') return;
  const parent = path.dirname(path.resolve(destination));
  if (parentIdentity !== undefined && publishDirectoryIdentity(parent) !== parentIdentity) {
    throw scriptAncestryFailure(destination, parent, 'parent_replaced');
  }
  const privateGids = lazyPrivateGroupIds();
  for (const ancestor of directoryChain(parent)) {
    const link = lstatIfPresentSync(ancestor);
    if (!link) continue;
    if (link.isSymbolicLink() && othersCreateEntriesIn(path.dirname(ancestor), privateGids)) {
      throw scriptAncestryFailure(destination, ancestor, 'planted_link');
    }
    const directory = link.isSymbolicLink() ? statDirectoryChain(ancestor) : link;
    if (!directory?.isDirectory()) continue;
    const exposure = untrustedWritableExposure(directory, privateGids());
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
  groups: readonly string[];
  passwd: readonly string[];
}>;

/**
 * The private group of `current`, in the one shape the exception admits: the group named after them.
 *
 * Ubuntu and Debian create one group per user, named after them, and set up that user's home directory
 * with it, often group-writable. Such a home is shared with no other local user, so it stays a valid
 * script destination. Every other group name stays outside the exception: this host's own records
 * cannot bound it, because macOS lists only part of `staff` in `/etc/group` while every local user
 * holds it, and a name service can add members to a group this machine cannot read.
 *
 * Membership comes from both places a member can appear: the group's own member list, and the users
 * whose primary group is this one. A member who is neither `current` nor root disqualifies the group.
 */
export function privateGroupIds(
  database: HostGroupDatabase,
  current: Readonly<{ uid: number | undefined; name: string | undefined }>,
): Set<number> {
  const privateIds = new Set<number>();
  if (current.uid === undefined || current.name === undefined) return privateIds;
  const uidByName = new Map<string, number>();
  const primaryMembers = new Map<number, string[]>();
  for (const line of database.passwd) {
    const [name, , rawUid, rawGid] = line.split(':');
    const uid = Number(rawUid);
    const gid = Number(rawGid);
    if (!name || !Number.isInteger(uid) || !Number.isInteger(gid)) continue;
    uidByName.set(name, uid);
    primaryMembers.set(gid, [...(primaryMembers.get(gid) ?? []), name]);
  }
  for (const line of database.groups) {
    const [name, , rawGid, rawMembers] = line.split(':');
    const gid = Number(rawGid);
    if (name !== current.name || !Number.isInteger(gid)) continue;
    const supplementary = (rawMembers ?? '').split(',').filter((member) => member.length > 0);
    const ids = [...supplementary, ...(primaryMembers.get(gid) ?? [])].map((member) =>
      uidByName.get(member),
    );
    if (ids.every((id) => id === current.uid || id === 0)) privateIds.add(gid);
  }
  return privateIds;
}

/** This host's private groups, read from the group database the first time the chain meets one. */
function lazyPrivateGroupIds(): () => ReadonlySet<number> {
  let cached: ReadonlySet<number> | undefined;
  return () =>
    (cached ??= privateGroupIds(
      { groups: readSystemFile('/etc/group'), passwd: readSystemFile('/etc/passwd') },
      { uid: process.getuid?.(), name: readCurrentUser() },
    ));
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

/** Why other local users can write in this directory, or `undefined` when only this user and root can. */
function untrustedWritableExposure(
  stats: fs.Stats,
  privateGids: ReadonlySet<number>,
): AncestryExposure | undefined {
  if (stats.mode & 0o1000) return undefined;
  if (stats.mode & 0o002) return 'world_writable';
  if (stats.mode & 0o020 && !privateGids.has(stats.gid)) return 'shared_group_writable';
  return undefined;
}

/** Whether other local users can create an entry here: how a component becomes their symbolic link. */
function othersCreateEntriesIn(directory: string, privateGids: () => ReadonlySet<number>): boolean {
  const stats = statDirectoryChain(directory);
  if (!stats) return false;
  if (stats.mode & 0o002) return true;
  return Boolean(stats.mode & 0o020) && !privateGids().has(stats.gid);
}

type AncestryExposure =
  | 'world_writable'
  | 'shared_group_writable'
  | 'planted_link'
  | 'parent_replaced';

function scriptAncestryFailure(
  destination: string,
  ancestor: string,
  exposure: AncestryExposure,
): AppError {
  const writableByOthers = exposure !== 'parent_replaced';
  return new AppError(
    'COMMAND_FAILED',
    writableByOthers
      ? `Refusing to save the script under ${ancestor}: another local user can write that part of the path.`
      : `The directory for ${destination} changed while the script was staged, so the script was not saved.`,
    {
      reason: writableByOthers ? 'script_ancestor_untrusted' : 'script_ancestry_replaced',
      exposure,
      path: destination,
      ancestor,
      hint: writableByOthers
        ? `Save the script under a directory only you can write, or share ${ancestor} safely with the sticky bit (chmod +t) and keep symbolic links out of the path.`
        : 'Re-record with open --save-script, or save under a directory nobody else can write.',
    },
  );
}

function readSystemFile(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
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
