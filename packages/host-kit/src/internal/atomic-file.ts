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
 * anything is staged, and it is judged again immediately before the link or rename. The file is created
 * private, because a recording is a transcript of what someone did on this machine.
 *
 * `parentIdentity` is what {@link publishDirectoryIdentity} returned for a parent the caller created or
 * checked before it staged this file.
 */
export function publishScriptFileSync(options: {
  destination: string;
  contents: string;
  publish?: AtomicPublishMode;
  parentIdentity?: string;
}): void {
  const expected =
    options.parentIdentity ?? publishDirectoryIdentity(path.dirname(options.destination));
  withAtomicPublishTempPathSync(options.destination, (temporaryPath) => {
    assertPrivateScriptDestination(options.destination, expected);
    fs.writeFileSync(temporaryPath, options.contents, { encoding: 'utf8', mode: SCRIPT_FILE_MODE });
    assertPrivateScriptDestination(options.destination, expected);
    if (options.publish === 'link-exclusive') {
      fs.linkSync(temporaryPath, options.destination);
    } else {
      fs.renameSync(temporaryPath, options.destination);
    }
  });
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
  const walk = walkParent(destination, trust);
  if (walk.reject !== undefined) throw walk.reject;
  // The script entry is created inside the deepest directory the walk reached, or below it through
  // directories that do not exist yet. Where other local users can add entries, one of them can add
  // this entry first and the recording is theirs, so the creation has to be refused.
  const deepest = statDirectoryChain(walk.deepest);
  if (deepest && othersCreateEntriesIn(deepest, trust)) {
    throw scriptAncestryFailure(destination, walk.deepest, 'shared_parent');
  }
}

/**
 * The parent of `destination`, made absolute but never normalized.
 *
 * `path.resolve` folds a `..` away, which is the one simplification this may not make: the kernel does
 * not make it either, so `.../work/../x` lands its entry beside the target of the link named `work`. The
 * spelled components are what the walk resolves; a relative destination keeps its relative spelling and
 * starts from the working directory, which is how it reaches the filesystem.
 */
function spelledParent(destination: string): string {
  if (path.isAbsolute(destination)) return path.dirname(destination);
  const parent = path.dirname(destination);
  return parent === '.' ? '' : parent;
}

/**
 * Where the walk stands: a directory it has already judged and physically reached, plus the names still
 * to resolve. `deepest` is the directory the entry is created in when the walk stops here.
 */
type WalkState = Readonly<{
  deepest: string;
  authority: DirectoryAuthority;
  /** Path components left to resolve, nearest first. */
  queue: readonly string[];
  /** Link targets expanded so far. */
  hops: number;
}>;

type WalkStep =
  | Readonly<{ kind: 'reject'; path: string; exposure: ScriptAncestryExposure }>
  | Readonly<{ kind: 'stop'; deepest: string }>
  | Readonly<{ kind: 'stand'; state: WalkState }>;

/** A walk that ended: the deepest directory reached, or the typed refusal. */
type WalkOutcome = Readonly<{ reject: AppError | undefined; deepest: string }>;

/**
 * Walks the spelled parent exactly as the kernel resolves a path, judging every step, and refuses at the
 * first step another local user could steer.
 *
 * No `realpath` is involved anywhere. `realpathSync` answers only with the FINAL directory, so any
 * directory the resolution stepped through can vanish from the answer, and from the judgment, whenever a
 * link leads on to another link, or a spelled prefix names a plain directory whose ground is shared.
 * Instead each component is resolved against the directory physically reached:
 *
 * - `.` is skipped; `..` moves to the parent of the directory physically stood in, which is judged like
 *   any other directory. Neither one is a name that has to exist.
 * - Any other component is lstat'ed in that directory. An absent component ends the walk, because the
 *   publish creates what is missing below here.
 * - A directory is judged and entered.
 * - A symbolic link is judged itself, against the directory that physically holds it, and its target's
 *   components go in front of the queue — restarting from `/` for an absolute target. Hops are counted
 *   against {@link MAX_SCRIPT_PATH_LINK_HOPS}, and crossing it is refused rather than trusted.
 * - A component that is neither a directory nor a link cannot carry a publish, and is refused.
 *
 * A relative destination starts from the process's resolved working directory: the caller already stands
 * there, and the walk cannot step above it.
 */
function walkParent(destination: string, trust: ScriptDestinationTrust): WalkOutcome {
  let step = startWalk(spelledParent(destination), trust);
  // Every step consumes a component, and every link hop counts against a fixed limit, so this ends.
  for (;;) {
    if (step.kind === 'reject') return { reject: refusalAt(destination, step), deepest: '/' };
    if (step.kind === 'stop') return { reject: undefined, deepest: step.deepest };
    const { state } = step;
    if (state.queue.length === 0) return { reject: undefined, deepest: state.deepest };
    step = stepWalk(state, trust);
  }
}

function refusalAt(
  destination: string,
  step: Readonly<{ path: string; exposure: ScriptAncestryExposure }>,
): AppError {
  return scriptAncestryFailure(destination, step.path, step.exposure);
}

/** The first state: `/` for an absolute spelling, the resolved working directory otherwise. */
function startWalk(parent: string, trust: ScriptDestinationTrust): WalkStep {
  const queue = pathComponents(parent);
  // A relative destination starts from the working directory as the kernel sees it, symlink-free: the
  // caller already stands there, so it is where the walk starts rather than a step it has to earn.
  if (parent !== '' && !path.isAbsolute(parent)) return standIn(path.resolve(''), queue, trust, 0);
  return standIn('/', queue, trust, 0);
}

/** Judges `directory` and stands the walk there, or refuses it. */
function standIn(
  directory: string,
  queue: readonly string[],
  trust: ScriptDestinationTrust,
  hops: number,
): WalkStep {
  const stats = statDirectoryChain(directory);
  if (stats === undefined) return { kind: 'reject', path: directory, exposure: 'not_a_directory' };
  const authority: DirectoryAuthority = { uid: stats.uid, gid: stats.gid, mode: stats.mode };
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) return { kind: 'reject', path: directory, exposure };
  return { kind: 'stand', state: { deepest: directory, authority, queue, hops } };
}

/** The names of `directory`, with every `.` resolved away the way the kernel resolves it. */
function pathComponents(directory: string): string[] {
  return directory.split('/').filter((component) => component.length > 0 && component !== '.');
}

/** Advances one component of the queue. */
function stepWalk(state: WalkState, trust: ScriptDestinationTrust): WalkStep {
  const [component, ...rest] = state.queue;
  if (component === undefined) return { kind: 'stop', deepest: state.deepest };
  // `..` is the parent of the directory PHYSICALLY stood in, not of the spelling: where `work` is a link,
  // `.../work/../x` steps back from the link's target and lands beside it.
  if (component === '..') return standIn(path.dirname(state.deepest), rest, trust, state.hops);
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
  const stats = lstatIfPresentSync(entry);
  // Nothing below here exists yet, so the publish creates it inside the directory the walk reached.
  if (stats === undefined) return { kind: 'stop', deepest: state.deepest };
  if (stats.isSymbolicLink()) return stepThroughLink(state, entry, stats, rest, trust);
  return standIn(entry, rest, trust, state.hops);
}

/**
 * One hop. The link is judged where it physically stands: inside a directory others may add entries to,
 * only a link this user or root owns, held by the sticky bit, is theirs to keep. Its target's components
 * then enter the queue, because the kernel steps into them next.
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
  const queue = [
    ...pathComponents(path.isAbsolute(target) ? target : path.join(state.deepest, target)),
    ...rest,
  ];
  // An absolute target restarts the walk at the root; a relative one continues from where the walk is.
  const home = path.isAbsolute(target) ? '/' : state.deepest;
  return standIn(home, queue, trust, state.hops + 1);
}

/**
 * How many link targets one destination walk expands before it refuses.
 *
 * Kept BELOW the smallest limit the supported kernels apply to a path of their own (macOS 32, Linux 40),
 * so this rule always reaches its own limit first and answers with its own typed reason. The walk counts
 * hops rather than letting the kernel answer `ELOOP`, because a walk that ran out of hops has NOT
 * established where the entry lands, and that is a refusal, not a pass.
 */
export const MAX_SCRIPT_PATH_LINK_HOPS = 30;

/**
 * One directory's identity on its filesystem, for a caller that must publish into the same one it
 * created or checked. `undefined` when the directory is absent or is not a directory.
 */
export function publishDirectoryIdentity(directory: string): string | undefined {
  if (process.platform === 'win32') return 'windows';
  const stats = statDirectoryChain(directory);
  return stats ? `${stats.dev}:${stats.ino}` : undefined;
}

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
 * `files` is the only source admitted. `systemd` is deliberately NOT admitted, even though it is the
 * default on some distributions: `systemd-userdbd` answers group membership from user records the two
 * files never see, which is exactly the member this rule could not read. Bracketed actions such as
 * `[NOTFOUND=return]` steer a lookup and add no source, so they are ignored. A missing line, an
 * unparseable line, or an unreadable file establishes nothing, and the exception is refused.
 */
export function nameServiceListsOnlyFiles(nsswitch: readonly string[] | undefined): boolean {
  if (nsswitch === undefined) return false;
  for (const database of ['passwd', 'group']) {
    const line = nsswitchLine(nsswitch, database);
    if (line === undefined) return false;
    if (!line.sources.every((source) => source === 'files')) return false;
    if (line.sources.length === 0) return false;
  }
  return true;
}

function nsswitchLine(lines: readonly string[], database: string): NsswitchLine | undefined {
  for (const raw of lines) {
    const source = (raw.split('#')[0] ?? '').trimStart();
    const [name, ...rest] = source.split(/[\s:]+/);
    if (name !== database) continue;
    // A bracketed action steers a lookup and lists no source.
    const sources = rest.filter((token) => token.length > 0 && !token.startsWith('['));
    return { database, sources };
  }
  return undefined;
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
 * Ubuntu and Debian create one group per user, named after them, and set up that user's home directory
 * with it, often group-writable and owned by that user. Such a home is shared with no other local user,
 * so it stays a valid script destination. Every other group stays outside the exception, and the rule
 * fails closed wherever completeness cannot be established:
 *
 * - `/etc/nsswitch.conf` must exist, be readable, and name `files` as the ONLY source for both `passwd`
 *   and `group`. Otherwise a name service could hold a member no file shows, and nothing here could see
 *   it. {@link nameServiceListsOnlyFiles} says what a name service may say.
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
 * The account name this process's uid maps to, read from the host account database. The name comes from
 * the same file the group records come from, so a caller standing in for that file and this name stays in
 * agreement. No `os.userInfo()`: that answers from a different source than the records being judged.
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

/** The file that says which sources the host looks in for accounts and groups. */
const NSSWITCH_FILE = '/etc/nsswitch.conf';

/**
 * The ways a step of the walk can be unsafe: somebody else can change what is in that directory, they
 * can create the entry the destination names, they can put the link there, or the step cannot be trusted
 * at all.
 *
 * `foreign_owned` — some other user owns it and can chmod, empty, or repopulate it whatever its mode.
 * `world_writable` / `shared_group_writable` — its mode opens its contents to others.
 * `shared_parent` — nobody else can change what is in it today, but they can add the missing entry.
 * `planted_link` — a symbolic link another user could have put in place of a directory, or could replace.
 * `link_loop_exceeded` — the walk expanded as many links as the kernel allows, so where it lands is not
 * established. A loop is refused, never trusted.
 * `not_a_directory` — a step of the path is something a publish cannot travel through.
 * `parent_replaced` — the directory the caller staged against is not the one it was.
 */
export type ScriptAncestryExposure =
  | 'foreign_owned'
  | 'world_writable'
  | 'shared_group_writable'
  | 'shared_parent'
  | 'planted_link'
  | 'link_loop_exceeded'
  | 'not_a_directory'
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
