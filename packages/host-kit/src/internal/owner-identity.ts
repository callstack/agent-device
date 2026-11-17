import fs from 'node:fs';
import {
  isProcessAlive,
  processStartTimesDiffer,
  isProcessZombie,
  readHostProcessIdentityObservations,
  readHostProcessIdentityObservationsAsync,
  readProcessIdentityFacts,
  readProcessStartTime,
  type HostProcessIdentityObservation,
} from './host-process.ts';

export type OwnerIdentity = {
  pid: number;
  startTime: string | null;
};

/** A process id accepted by Node's native signal API. */
export function isProcessPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0x7fff_ffff;
}

export type OwnerLiveness =
  | 'live'
  | 'owner-process-dead'
  | 'owner-process-reused'
  | 'owner-state-dir-gone'
  | 'unknown';

let currentOwnerIdentity: Readonly<OwnerIdentity> | undefined;

/**
 * This process's identity. A process's own start time never changes, so the first readable answer
 * is kept for the life of the process and every later call is free. An unreadable start time is
 * not kept: the next call asks the host again rather than recording an owner without one.
 */
export function readCurrentOwnerIdentity(): OwnerIdentity {
  return rememberedOwnerIdentity() ?? rememberOwnerIdentity(readProcessStartTime(process.pid));
}

/** {@link readCurrentOwnerIdentity} for a caller that is already waiting: no blocking `ps`. */
export async function readCurrentOwnerIdentityAsync(): Promise<OwnerIdentity> {
  return (
    rememberedOwnerIdentity() ??
    rememberOwnerIdentity((await readProcessIdentityFacts(process.pid)).startTime)
  );
}

function rememberedOwnerIdentity(): OwnerIdentity | undefined {
  return currentOwnerIdentity?.pid === process.pid ? { ...currentOwnerIdentity } : undefined;
}

function rememberOwnerIdentity(startTime: string | null): OwnerIdentity {
  const identity = { pid: process.pid, startTime };
  if (startTime !== null) currentOwnerIdentity = Object.freeze({ ...identity });
  return identity;
}

export function ownerIdentityMatches(
  left: Pick<OwnerIdentity, 'pid' | 'startTime'>,
  right: Pick<OwnerIdentity, 'pid' | 'startTime'>,
): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

/**
 * Positive proof that two records name DIFFERENT processes. Deliberately not
 * the negation of {@link ownerIdentityMatches}: equal pids with an unreadable
 * start time on either side are unproven rather than different, so a caller
 * that acts on this can never mistake one owner for two and hand its resource
 * away.
 */
export function ownerIdentityDiffers(
  left: Pick<OwnerIdentity, 'pid' | 'startTime'>,
  right: Pick<OwnerIdentity, 'pid' | 'startTime'>,
): boolean {
  if (left.pid !== right.pid) return true;
  return processStartTimesDiffer(left.startTime, right.startTime);
}

/**
 * This is deliberately proof-oriented, in both directions. A filesystem read
 * error is not proof that an owner state directory disappeared, so callers
 * must surface it as an unknown owner rather than treating the resource as
 * free. Likewise a failed `ps` read (it shells out with a short timeout and
 * loses under CPU contention) is not proof the owner died, so it never
 * condemns a pid that kill(pid, 0) says is alive. Death is only concluded
 * from positive evidence: the pid is gone or the process is a zombie (already
 * terminated, merely unreaped). A different readable start time proves PID
 * reuse, but remains a distinct result so each ownership policy must decide
 * explicitly whether that proof permits recovery. An unreadable start time is
 * not proof of reuse. An owner recorded without a start time stays fail-closed
 * while its pid is alive: there is no same-clock-domain proof of birth order (wall-clock
 * arithmetic over `ps etime` shifts under clock steps), and misreading a live
 * owner as recycled would let a waiter steal a held resource.
 */
export function classifyOwnerLiveness(params: {
  owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
  stateDir?: string;
}): OwnerLiveness {
  // One process-table snapshot answers the whole judgment. State and start time
  // read as two probes double the cost of every lock-ownership poll on hosts
  // where a probe starts a fresh process tool, and one snapshot also judges both
  // facts at the same instant instead of stitching two separate host answers.
  const guarded = guardOwnerPid(params.owner);
  if (guarded) return guarded;
  const observation =
    readHostProcessIdentityObservations([params.owner.pid]).get(params.owner.pid) ?? null;
  return classifyLiveOwnerFromObservation(params, observation);
}

/**
 * {@link classifyOwnerLiveness} off the event loop, for a caller that is already waiting. A pid
 * that `kill(pid, 0)` already proves dead is judged without running the process tool at all.
 */
export async function classifyOwnerLivenessAsync(params: {
  owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
  stateDir?: string;
}): Promise<OwnerLiveness> {
  const guarded = guardOwnerPid(params.owner);
  if (guarded) return guarded;
  const observations = await readHostProcessIdentityObservationsAsync([params.owner.pid]);
  return classifyOwnerLivenessFromObservation(params, observations.get(params.owner.pid) ?? null);
}

export function classifyOwnerLivenessFromObservation(
  params: {
    owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
    stateDir?: string;
  },
  observation?: HostProcessIdentityObservation | null,
): OwnerLiveness {
  // The snapshot was taken before this call, so the guards run again here: a
  // claim whose owner died between snapshot and judgment must read dead.
  const guarded = guardOwnerPid(params.owner);
  if (guarded) return guarded;
  return classifyLiveOwnerFromObservation(params, observation);
}

/** The verdicts provable from the pid alone; undefined means the caller may probe on. */
function guardOwnerPid(owner: Pick<OwnerIdentity, 'pid' | 'startTime'>): OwnerLiveness | undefined {
  if (!isProcessPid(owner.pid)) return 'unknown';
  if (!isProcessAlive(owner.pid)) return 'owner-process-dead';
  return undefined;
}

/** Judges an owner the caller has established as a live, valid pid; probes no liveness. */
function classifyLiveOwnerFromObservation(
  params: {
    owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
    stateDir?: string;
  },
  observation?: HostProcessIdentityObservation | null,
): OwnerLiveness {
  const { owner, stateDir } = params;
  if (hostSaysZombie(owner, observation)) return 'owner-process-dead';
  if (owner.startTime && provesPidReused(owner, observation)) return 'owner-process-reused';
  return stateDir ? classifyOwnerStateDirectory(stateDir) : 'live';
}

/**
 * Whether the host calls this owner a zombie. An `undefined` observation means
 * no snapshot was taken and the field probe answers; a `null` observation is a
 * completed snapshot that did not list the pid, which is unknown evidence and
 * never a zombie claim.
 */
function hostSaysZombie(
  owner: Pick<OwnerIdentity, 'pid'>,
  observation: HostProcessIdentityObservation | null | undefined,
): boolean {
  if (observation === undefined) return isProcessZombie(owner.pid);
  return observation?.state.startsWith('Z') ?? false;
}

/**
 * Whether the recorded birth time proves the pid changed hands. Only a
 * readable current start time that differs from the record proves reuse; an
 * `undefined` observation falls back to the field probe, and a host that did
 * not answer is unknown evidence, never proof.
 */
function provesPidReused(
  owner: Pick<OwnerIdentity, 'pid' | 'startTime'>,
  observation: HostProcessIdentityObservation | null | undefined,
): boolean {
  const currentStartTime =
    observation === undefined ? readProcessStartTime(owner.pid) : (observation?.startTime ?? null);
  return processStartTimesDiffer(currentStartTime, owner.startTime);
}

function classifyOwnerStateDirectory(stateDir: string): OwnerLiveness {
  try {
    fs.statSync(stateDir);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'owner-state-dir-gone';
    return 'unknown';
  }
}

// --- the account this process's uid resolves to, and whether its group holds anybody else ---

/**
 * The rules below answer who this UID is in the host's own account records, because a destination's
 * safety can depend on it: a directory writable by a group is writable by every member of that group,
 * and its permission bits do not say who they are. These reads are READ-ONLY: nothing here writes,
 * chmods, or creates anything.
 */

/** What a caller asks about: the owner and the group one `lstat` of a directory reports. */
export type GroupMembership = Readonly<{ uid: number; gid: number }>;

/** The host files this rule reads. One record, so a caller and a test each name a path once. */
export const PRIVATE_GROUP_HOST_FILES = {
  group: '/etc/group',
  nsswitch: '/etc/nsswitch.conf',
  passwd: '/etc/passwd',
} as const;

/**
 * The host answers this rule asks for, injected so a test can supply account records of its own.
 *
 * `read` answers the contents of one file, or `undefined` when the host will not open it. An
 * unreadable file is NOT an empty one, and the two answers differ. `uid` answers this process's uid,
 * or `undefined` when the host reports none.
 */
export type PrivateGroupHost = Readonly<{
  read?: (path: string) => string | undefined;
  uid?: () => number | undefined;
}>;

/** One account record: the name, uid, and primary gid a passwd line names. */
type AccountRecord = Readonly<{ gid: number; name: string; uid: number }>;

/** One group record: the gid a group line names, and the members that line lists. */
type GroupRecord = Readonly<{ gid: number; members: readonly string[] }>;

/** One `database: sources` clause of `/etc/nsswitch.conf`, with comments and spacing removed. */
type NameServiceClause = Readonly<{ database: string; sources: readonly string[] }>;

/**
 * The name services that answer from root-owned local records. `systemd` is admitted because
 * `systemd-userdbd` reads root-owned drop-ins, the same trust `/etc/group` carries.
 */
const LOCAL_NAME_SOURCES: ReadonlySet<string> = new Set(['files', 'systemd']);

/**
 * The databases this rule must trust. `initgroups` decides which extra groups a process holds, so it
 * counts even though no file read here lists a process's supplementary groups.
 */
const ACCOUNT_DATABASES: readonly string[] = ['group', 'initgroups', 'passwd'];

/** The whole-word database key that opens one `/etc/nsswitch.conf` clause. */
const CLAUSE_KEY = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/;

/**
 * Whether a group-writable directory is safe because its group belongs to this user alone.
 *
 * A group-writable directory is writable by every member of its group, and its mode does not say who
 * they are. This rule reads the host's own account files and accepts the shape a stock Ubuntu or
 * Debian install creates: one group per user, named after that user, numbered the same as their uid.
 *
 * Every condition must hold:
 *
 * - `directory.uid` is this process's uid. The owner of a directory chooses its group, so a directory
 *   another user owns is theirs to re-group whatever this answer says.
 * - `directory.gid` is this user's PRIMARY gid as the passwd database records it. The process gid is
 *   not asked: a process can hold a group its own account does not.
 * - EVERY group record that carries that gid lists no member except this user. A directory writable by
 *   gid 1000 is writable by the members of each group holding that number, however it is named, so one
 *   further record naming anybody else ends the claim. A record that lists nobody is enough, which is
 *   the shape an installer writes for a per-user group.
 * - No other passwd record lists that gid as its primary group. Such an account holds the group with no
 *   mention of it in the group database at all.
 * - Every record of both databases is readable and unambiguous, and one of them carries that gid. A gid
 *   no group record carries is refused: the account file names a group the group file never shows, so
 *   nothing here says who belongs to it.
 * - The name services the host trusts for `passwd`, `group`, and `initgroups` are local ones.
 *   {@link nameServiceSourcesAreLocal} says what a source may be.
 *
 * Anything unreadable, unparseable, or ambiguous answers `false`, and the function throws nothing out.
 * A refused directory stays safe, and an accepted one cannot be taken back.
 */
export function privateGroupOwned(directory: GroupMembership, host?: PrivateGroupHost): boolean {
  try {
    return groupIsPrivateToThisUser(directory, host ?? {});
  } catch {
    // A host that answers in a way this rule did not foresee is refused, never assumed safe.
    return false;
  }
}

/** The whole judgment, for a host already established and every answer read defensively. */
function groupIsPrivateToThisUser(directory: GroupMembership, host: PrivateGroupHost): boolean {
  const uid = readCurrentUid(host);
  if (uid === undefined || directory.uid !== uid) return false;
  if (!nameServiceSourcesAreLocal(readAccountFile(host, PRIVATE_GROUP_HOST_FILES.nsswitch)))
    return false;

  const passwd = readDatabase(
    readAccountFile(host, PRIVATE_GROUP_HOST_FILES.passwd),
    parsePasswdRecord,
  );
  if (passwd === undefined) return false;
  const account = passwdRecordForUid(passwd, uid);
  if (account === undefined || account.gid !== directory.gid) return false;
  // Any other account whose primary group is this gid holds the group without appearing in it.
  if (passwd.some((record) => record.gid === directory.gid && !isSameAccount(record, account)))
    return false;

  const groups = readDatabase(
    readAccountFile(host, PRIVATE_GROUP_HOST_FILES.group),
    parseGroupRecord,
  );
  if (groups === undefined) return false;
  const carriers = groups.filter((group) => group.gid === directory.gid);
  if (carriers.length === 0) return false;
  return carriers.every((group) => group.members.every((member) => member === account.name));
}

/** This process's uid, from the seam when it supplies one and from the kernel when it does not. */
function readCurrentUid(host: PrivateGroupHost): number | undefined {
  const uid = host.uid ? host.uid() : process.getuid?.();
  return uid !== undefined && Number.isInteger(uid) && uid >= 0 ? uid : undefined;
}

/** The contents of one account file, or `undefined` when the host will not open it. */
function readAccountFile(host: PrivateGroupHost, file: string): string | undefined {
  if (host.read) return host.read(file);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The one passwd record for `uid`, or `undefined` when the database has none or has two. Two records
 * for one uid leave this user's primary gid ambiguous, so neither of them is the account.
 */
function passwdRecordForUid(
  records: readonly AccountRecord[],
  uid: number,
): AccountRecord | undefined {
  const mine = records.filter((record) => record.uid === uid);
  return mine.length === 1 ? mine[0] : undefined;
}

function isSameAccount(record: AccountRecord, account: AccountRecord): boolean {
  return record.uid === account.uid && record.name === account.name;
}

/**
 * The records of one database, or `undefined` when the file was not read, holds no record, or holds a
 * line `parse` cannot read. A caller that cannot enumerate every record proves nothing about one.
 */
function readDatabase<T>(
  text: string | undefined,
  parse: (line: string) => T | undefined,
): T[] | undefined {
  if (text === undefined) return undefined;
  const records: T[] = [];
  for (const rawLine of text.split('\n')) {
    // A blank line carries no record. glibc's own readers step over it too.
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    // A line that cannot be read makes the whole database unenumerable, so nothing is proven.
    const record = parse(line);
    if (record === undefined) return undefined;
    records.push(record);
  }
  // An empty database holds no record to prove this group private.
  return records.length === 0 ? undefined : records;
}

function parsePasswdRecord(line: string): AccountRecord | undefined {
  const fields = line.split(':');
  // A passwd line keeps a gecos, home, and shell after the gid; none of them names an identity.
  if (fields.length < 4) return undefined;
  const name = fields[0];
  const uid = parseIdentity(fields[2]);
  const gid = parseIdentity(fields[3]);
  if (name === undefined || name === '' || uid === undefined || gid === undefined) return undefined;
  return { gid, name, uid };
}

function parseGroupRecord(line: string): GroupRecord | undefined {
  const fields = line.split(':');
  // The member list is one field, so a line running past it is not one readable group.
  if (fields.length < 3 || fields.length > 4) return undefined;
  const name = fields[0];
  const gid = parseIdentity(fields[2]);
  if (name === undefined || name === '' || gid === undefined) return undefined;
  return { gid, members: splitList(fields[3]) };
}

function splitList(field: string | undefined): readonly string[] {
  if (field === undefined || field === '') return [];
  return field.split(',').filter((entry) => entry !== '');
}

/** An identity number, or `undefined` when the field is not one. */
function parseIdentity(field: string | undefined): number | undefined {
  if (field === undefined || !/^\d+$/.test(field)) return undefined;
  return Number(field);
}

/**
 * Whether `/etc/nsswitch.conf` establishes that local records answer every identity lookup.
 *
 * A missing or unreadable file establishes nothing. A database the file states MORE THAN ONCE
 * establishes nothing either, and that is a refusal rather than a reading of one of the lines. glibc
 * keeps the LAST clause for a database and discards the earlier ones, so a file stating `group` twice
 * is a config two readers can disagree about, and neither reading is the one to trust.
 *
 * An absent `initgroups` clause inherits the `group` clause, which is glibc behavior, so its absence
 * is covered by the answer for `group`. A stated `initgroups` clause is trusted on its own.
 *
 * A clause may list only the sources in {@link LOCAL_NAME_SOURCES}. A bracketed action such as
 * `[NOTFOUND=return]` steers where a lookup stops, so it is refused rather than ignored: whether it
 * ends a lookup is a reading no local file settles. An empty source list is refused too, because it
 * names a database no lookup reads at all.
 */
function nameServiceSourcesAreLocal(nsswitch: string | undefined): boolean {
  if (nsswitch === undefined) return false;
  const clauses = parseNameServiceClauses(nsswitch);
  if (clauses === undefined) return false;

  const stated: NameServiceClause[] = [];
  for (const clause of clauses) {
    if (!ACCOUNT_DATABASES.includes(clause.database)) continue;
    // Two clauses for one database: refuse, and do not choose between them.
    if (stated.some((seen) => seen.database === clause.database)) return false;
    stated.push(clause);
  }

  const group = sourcesOf(stated, 'group');
  const passwd = sourcesOf(stated, 'passwd');
  if (group === undefined || passwd === undefined) return false;
  if (!sourcesAreLocal(group) || !sourcesAreLocal(passwd)) return false;
  // Absent `initgroups` inherits `group`, so an untrusted `group` can never be inherited as trusted.
  return sourcesAreLocal(sourcesOf(stated, 'initgroups') ?? group);
}

function sourcesOf(
  clauses: readonly NameServiceClause[],
  database: string,
): readonly string[] | undefined {
  return clauses.find((clause) => clause.database === database)?.sources;
}

/** The clauses of one file, or `undefined` when a line is not a clause this rule can read. */
function parseNameServiceClauses(text: string): NameServiceClause[] | undefined {
  const clauses: NameServiceClause[] = [];
  for (const rawLine of text.split('\n')) {
    // A `#` opens a comment wherever it stands, and the rest of that line is not a clause.
    const line = (rawLine.split('#')[0] ?? '').replace(/\r$/, '').trim();
    if (line === '') continue;
    const clause = CLAUSE_KEY.exec(line);
    if (clause?.[1] === undefined) return undefined;
    clauses.push({ database: clause[1], sources: splitSources(clause[2]) });
  }
  return clauses;
}

function splitSources(sources: string | undefined): readonly string[] {
  return (sources ?? '')
    .trim()
    .split(/[ \t]+/)
    .filter((source) => source !== '');
}

function sourcesAreLocal(sources: readonly string[]): boolean {
  return sources.length > 0 && sources.every((source) => LOCAL_NAME_SOURCES.has(source));
}
