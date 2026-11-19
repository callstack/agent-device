import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  expandUserHomePath,
  spelledRouteNames,
  spelledRouteStepsBackOut,
} from '@agent-device/host-kit/file';
import { findProjectRoot, isSourceCheckoutProjectRoot } from '@agent-device/host-kit/version';
import { AppError } from '@agent-device/kernel/errors';
import { type EnvMap } from '@agent-device/kernel/source-value';

import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { OwnerIdentity } from '@agent-device/host-kit/process';
import type { DaemonServerMode, DaemonTransportPreference } from '@agent-device/kernel/contracts';
export type { DaemonServerMode, DaemonTransportPreference };

/**
 * Where a daemon lives and how to reach it, resolved from raw env/arg values. The client and the
 * daemon both read this subset — the client to find or launch a daemon, the daemon to bind one —
 * so it sits at the process root rather than under `packages/daemon/src/`, where a client would have to
 * reach daemon internals to resolve an address. `packages/daemon/src/core/config.ts` adds the request-scoping
 * rules that only the daemon applies on top of this. What a daemon publishes about itself
 * (`capabilities`) and the one request that asks it to leave (`quiesce`) belong here for the same
 * reason: the client addresses a daemon with them and the daemon answers by them.
 */

export type DaemonPaths = {
  baseDir: string;
  infoPath: string;
  lockPath: string;
  logPath: string;
  allocationsDir: string;
  sessionsDir: string;
};

type ResolveDaemonPathsOptions = {
  env?: EnvMap;
  /** Resolves a relative state dir; a relative one without it is refused. */
  cwd?: string;
  projectRoot?: string;
};

export function resolveDaemonPaths(
  stateDir: string | undefined,
  options: ResolveDaemonPathsOptions = {},
): DaemonPaths {
  const baseDir = resolveStateDir(stateDir, options);
  return {
    baseDir,
    infoPath: path.join(baseDir, 'daemon.json'),
    lockPath: path.join(baseDir, 'daemon.lock'),
    logPath: path.join(baseDir, 'daemon.log'),
    allocationsDir: path.join(baseDir, 'allocations'),
    sessionsDir: path.join(baseDir, 'sessions'),
  };
}

function resolveStateDir(raw: string | undefined, options: ResolveDaemonPathsOptions): string {
  const value = (raw ?? '').trim();
  if (!value) {
    return resolveDefaultDaemonStateDir(options);
  }
  const expanded = expandUserHomePath(value, { env: options.env });
  if (!path.isAbsolute(expanded) && options.cwd === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      `State dir "${value}" is relative and no working directory was given.`,
      {
        reason: 'relative_state_dir_without_cwd',
      },
    );
  }
  // A Windows route can name a DRIVE without naming a directory on it — `C:work` means "work, below wherever
  // drive C is standing right now". Where that drive stands is established when the caller supplied a working
  // directory absolute on the SAME drive, and is not established at all otherwise; both answers belong to
  // {@link anchorDriveRelativeStateRoute}, which owns the decision. A spelling that carries no drive on this
  // host is an ordinary relative name and takes the ordinary route below.
  const anchored = anchorDriveRelativeStateRoute(value, expanded, options.cwd);
  // Joined TEXTUALLY rather than with `path.resolve`, and anchored once: this is the ONE base every record name is
  // then built from, so the join must add nothing to what the operator named beyond the working directory a
  // relative spelling is given against. A drive-relative route enters the fold below UN-folded like every other
  // relative route — `path.resolve` would fold its `..` there unproven, and the fold is the only place that
  // question is answered.
  const anchor = path.isAbsolute(expanded) ? '' : path.resolve(options.cwd ?? '');
  const route = anchored ?? (anchor === '' ? expanded : joinTextually(anchor, expanded));
  // A parent-relative state dir is an ordinary configuration — `--state-dir ../shared-state` beside a checkout —
  // and it stays supported, as it was before this branch. What it cannot be is passed on UN-folded: the record
  // names are derived with `path.join`, which folds a `..` away, so an un-folded base would be JUDGED as one
  // directory and WRITTEN into as another, and `daemon.json` would record a directory holding no records. The fold
  // therefore happens HERE, once, and every entry of `DaemonPaths` is derived from the folded base.
  //
  // Folding is faithful exactly while each step backs out of a directory that is provably not a link: `name/..`
  // returns to the parent of whatever NAME resolves to, so a link at `name` makes the spelling mean the target's
  // parent while the fold says the directory the text names. A step whose ground cannot be said — a link, or an
  // `lstat` the host refuses — is therefore refused rather than folded, because folding an uncertain route is how
  // records end up in a base nothing judged. Every directory a fold steps OUT OF stands above the state root,
  // where ADR 0016 allows links, which is why this is asked here — at the one point where the route is still a
  // spelling — and cannot be reconstructed from folded text afterwards.
  if (stepsBackOut(route)) return foldParentRelativeStateRoute(value, route);
  return route;
}

/**
 * Decides a DRIVE-RELATIVE state route — `C:work`, “work below wherever drive C stands” — and answers the
 * route the resolver builds from it, or `undefined` for a spelling that names no drive and takes the ordinary
 * relative route. The decision, not just its parts:
 *
 * - A working directory ABSOLUTE ON THE SAME DRIVE is where that drive stands for this run: the host would
 *   itself open `C:\project\work` for `C:work` from `C:\project`, so the route is anchored there and the base
 *   is one directory. The assembly places the spelling's names under the anchor's with the platform's own root
 *   and separator, and a `..` among them SURVIVES un-folded — folding one here would be the unproven
 *   substitution {@link foldParentRelativeStateRoute} refuses to make anywhere else, and the fold below judges
 *   what this returns.
 * - No cwd, a cwd that is not absolute, or a cwd anchored anywhere but that drive (another drive letter, a UNC
 *   scope): the host would answer these with a per-process, per-drive current directory no caller named. No
 *   anchor is established, and the route is REFUSED typed, because this is the ONE base every record name is
 *   built from and a guess is never better than an error an operator can act on.
 *
 * @param platform the host's path API, asked of the caller rather than assumed, as in the fold above.
 */
export function anchorDriveRelativeStateRoute(
  value: string,
  spelled: string,
  cwd: string | undefined,
  platform: typeof path = path,
): string | undefined {
  if (platform.isAbsolute(spelled)) return undefined;
  const drive = platform.parse(spelled).root;
  if (drive.length === 0) return undefined;
  const standing = cwd === undefined ? '' : platform.parse(cwd).root;
  if (cwd !== undefined && platform.isAbsolute(cwd) && namesSameDrive(drive, standing)) {
    const anchor = splitSpelledRoute(cwd, platform);
    const below = splitSpelledRoute(spelled, platform);
    return joinSpelledRoute(anchor.root, [...anchor.names, ...below.names], platform);
  }
  throw new AppError(
    'INVALID_ARGS',
    `State dir "${value}" names a drive without a directory on it and no working directory on that drive ` +
      'was given, so which directory its records land in is not established. Name the state directory with ' +
      'a full path such as ' +
      String.raw`C:\work\agent-device` +
      '.',
    { reason: 'state_dir_drive_relative', drive },
  );
}

/**
 * Whether two roots name the one drive; a Windows drive letter is case-insensitive. A root that is not a
 * drive's — a POSIX `/`, or a UNC scope — answers no letter pair and matches no spelling's drive this way.
 */
function namesSameDrive(spelled: string, standing: string): boolean {
  return /^[a-zA-Z]:/.test(spelled) && /^[a-zA-Z]:/.test(standing)
    ? spelled.slice(0, 2).toLowerCase() === standing.slice(0, 2).toLowerCase()
    : false;
}

/**
 * Folds the `name/..` pairs an ABSOLUTE state route asks for, having proven each fold faithful.
 *
 * The walk and the result are built with the platform's own path API, never by rebuilding a string from a fixed
 * separator: a Windows route carries a drive (`C:\`) or a UNC scope (`\\server\share\`) as its root, which a leading
 * `/` would silently drop into another scope, and a POSIX name may legitimately contain a backslash, which only the
 * host's own separator may split on.
 *
 * @param platform the host's path API, asked of the caller rather than assumed, so the fold a Windows host gets is
 *   the one this rule means and can be checked without one.
 */
export function foldParentRelativeStateRoute(
  value: string,
  route: string,
  platform: typeof path = path,
): string {
  const { root, names } = splitSpelledRoute(route, platform);
  const stood: string[] = [];
  for (const name of names) {
    if (name !== '..') {
      stood.push(name);
      continue;
    }
    // A step with nothing to leave changes nothing, which is what a route that climbs past its root spells.
    if (stood.length === 0) continue;
    const leaving = joinSpelledRoute(root, stood, platform);
    const standing = hostStandingAt(leaving);
    if (standing === 'link') {
      throw new AppError(
        'INVALID_ARGS',
        `State dir "${value}" steps back out from the symbolic link ${leaving}, so which directory its ` +
          'records land in is not established. Name the state directory without a ".." step, or remove that ' +
          'link.',
        { reason: 'state_dir_parent_step_through_link', details: { link: leaving } },
      );
    }
    if (standing === 'unverified') {
      throw new AppError(
        'INVALID_ARGS',
        `State dir "${value}" steps back out from ${leaving}, which this process cannot inspect, so it ` +
          'cannot tell whether that step is a symbolic link and where the records would land. Make that ' +
          'directory readable and searchable by the user that runs agent-device, or name the state directory ' +
          'without a ".." step.',
        { reason: 'state_dir_parent_step_unverified', details: { directory: leaving } },
      );
    }
    stood.pop();
  }
  return joinSpelledRoute(root, stood, platform);
}

/**
 * Whether the directory a step back out leaves is a link, seen by `lstat` so a link is not followed.
 *
 * Absence is answered APART from a fault, and the two are not interchangeable. `absent` is the ordinary case —
 * `../shared-state` beside a checkout stands nowhere before the daemon's first start, and a level that does not
 * stand cannot be a link — so the fold stays textual. `unverified` is a lookup the host refused or failed, which
 * says nothing about what stands there: a route in that state is never folded into a different base.
 */
function hostStandingAt(pathname: string): 'link' | 'plain' | 'absent' | 'unverified' {
  try {
    return fs.lstatSync(pathname).isSymbolicLink() ? 'link' : 'plain';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'absent' : 'unverified';
  }
}

/** Splits a spelled route into its platform root and the names below it, without folding anything away. */
function splitSpelledRoute(
  route: string,
  platform: typeof path,
): Readonly<{ root: string; names: string[] }> {
  const root = platform.parse(route).root;
  return { root, names: spelledRouteNames(route.slice(root.length), platform) };
}

/** Puts names back under a platform root, which already carries its own trailing separator. */
function joinSpelledRoute(root: string, names: readonly string[], platform: typeof path): string {
  return `${root}${names.join(platform.sep)}`;
}

/**
 * Puts a spelled relative path under `cwd` without folding any name away.
 *
 * `path.join` and `path.resolve` both fold a `..` the moment they are asked, which is the substitution this rule
 * refuses to make unproven, so the anchor is concatenated and the host separator is the only thing inserted.
 */
function joinTextually(cwd: string, spelled: string): string {
  const relative = spelled.replace(/^\.\//, '');
  if (!cwd) return relative;
  return cwd.endsWith(path.sep) ? `${cwd}${relative}` : `${cwd}${path.sep}${relative}`;
}

/** Whether a spelled path asks for a step back out of the directory it is in, on the host's own separator. */
function stepsBackOut(spelled: string): boolean {
  return spelledRouteStepsBackOut(spelled);
}

function resolveDefaultDaemonStateDir(options: ResolveDaemonPathsOptions = {}): string {
  const globalStateDir = path.join(expandUserHomePath('~', { env: options.env }), '.agent-device');
  const projectRoot = options.projectRoot ?? findProjectRoot();
  if (!isSourceCheckoutProjectRoot(projectRoot)) {
    return globalStateDir;
  }
  return path.join(globalStateDir, 'dev', buildSourceCheckoutStateDirName(projectRoot));
}

function buildSourceCheckoutStateDirName(projectRoot: string): string {
  const resolvedRoot = resolveRealPath(projectRoot);
  const slug = path.basename(resolvedRoot).replaceAll(/[^a-zA-Z0-9._-]+/g, '-');
  const hash = crypto.createHash('sha1').update(resolvedRoot).digest('hex').slice(0, 12);
  return `${slug || 'agent-device'}-${hash}`;
}

function resolveRealPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/** What `daemon.json` holds: no file, a file that cannot be read, text that is not a record, or the record. */
export type DaemonRecordRead =
  | Readonly<{ status: 'absent' | 'unreadable' | 'invalid' }>
  | Readonly<{ status: 'present'; record: Readonly<Record<string, unknown>> }>;

/**
 * The one reader of `daemon.json`; registration, status and the client's connection info are
 * projections of it. Only a path the host reports as gone proves there is no record: a permission
 * error or I/O fault leaves a file whose contents are unknown, which no caller may read as "someone
 * removed it".
 */
export function readDaemonRecord(infoPath: string): DaemonRecordRead {
  let raw: string;
  try {
    raw = fs.readFileSync(infoPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { status: code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { status: 'present', record: parsed as Record<string, unknown> }
      : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

/** The transport a daemon recorded in `daemon.json`; anything else is no recorded transport. */
export function readRecordedDaemonTransport(value: unknown): DaemonServerMode | undefined {
  return value === 'socket' || value === 'http' || value === 'dual' ? value : undefined;
}

export function resolveDaemonServerMode(raw: string | undefined): DaemonServerMode {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'http') return 'http';
  if (normalized === 'dual') return 'dual';
  return 'socket';
}

export function resolveDaemonTransportPreference(
  raw: string | undefined,
): DaemonTransportPreference {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (normalized === 'socket') return 'socket';
  if (normalized === 'http') return 'http';
  if (normalized === 'dual') return 'auto';
  return 'auto';
}

/** What a daemon can do beyond the base RPC contract, published in its `daemon.json`. */
export const DAEMON_CAPABILITIES = ['quiesce', 'script-artifacts'] as const;
export type DaemonCapability = (typeof DAEMON_CAPABILITIES)[number];

/**
 * Who owns the process a registration names, and so who may end it.
 *
 * - `detached`: the daemon is its own process, which a stop may signal. This is what a record that
 *   predates the field names.
 * - `embedded`: the host that started the runtime owns the process. Nothing in the central
 *   lifecycle signals that PID, not even hung recovery or a forced stop: the host closes the
 *   runtime through its own close. An outside stop refuses a live host without a request or
 *   signal, and may retire the registration after proving the recorded host lifetime exited.
 * - `unknown`: the record states an owner this build does not recognize, so no process may be
 *   signaled on its strength. Signalling on a guess could end a host process, and a value this
 *   build cannot read is exactly the case where the safe answer is to do nothing.
 */
const DAEMON_OWNERSHIPS = ['detached', 'embedded', 'unknown'] as const;
export type DaemonOwnership = (typeof DAEMON_OWNERSHIPS)[number];

/**
 * The ownership a process can state about *itself*: `unknown` is what a reader answers for a record it
 * cannot place, never what a runtime knows about its own process. So a runtime starts as detached or
 * embedded, and the refusal for a record this build cannot read belongs to the code that reads the
 * record — see {@link readDaemonOwnership}.
 */
export type DaemonRuntimeOwnership = Exclude<DaemonOwnership, 'unknown'>;

/**
 * The lifetime a lifecycle path has proved the daemon on a state directory is, together with the owner
 * its record stated at that read. Ownership travels inside the observation because a pid only says what
 * is safe to end once its owner is known, and two reads of `daemon.json` can name different pairs.
 */
export type ObservedDaemonIdentity = OwnerIdentity & {
  ownership: DaemonOwnership;
};

/**
 * The ownership a `daemon.json` field records. An absent field is the pre-existing detached daemon —
 * every record written before #3757 states no owner and describes a daemon that is its own process.
 * A field that states something else is `unknown`, and is never folded into `detached`: the two read
 * the same way to a caller that is about to signal a pid, and only one of them is safe to act on.
 */
export function readDaemonOwnership(value: unknown): DaemonOwnership {
  return DAEMON_OWNERSHIPS.includes(value as DaemonOwnership)
    ? (value as DaemonOwnership)
    : value === undefined
      ? 'detached'
      : 'unknown';
}

/** Stop if idle: refuses while the detached daemon holds work. */
export const DAEMON_QUIESCE_COMMAND = 'daemon_quiesce';

/** The reason a daemon gives every request it refuses once it has begun to leave. */
export const DAEMON_SHUTTING_DOWN_REASON = 'daemon_shutting_down';

/** Why a daemon refuses a lifecycle request: one entry per rule the admission seam enforces. */
export const DAEMON_LIFECYCLE_REASONS = {
  /** A quiesce found the daemon holding work, so nothing was accepted. */
  busy: 'daemon-busy',
  /** The request names a different daemon instance than the one answering it. */
  instanceMismatch: 'daemon-instance-mismatch',
  /** A host owns this runtime and ends it through its own close. */
  ownerEmbedded: 'daemon-owner-embedded',
} as const;

/**
 * The refusal for a `daemon.json` whose owner field this build cannot place. No daemon answers it: a
 * runtime always knows whether it owns itself, so `unknown` is a verdict about a file, and only a reader
 * can reach it.
 */
export const DAEMON_RECORD_OWNER_UNRECOGNIZED_REASON = 'daemon-owner-unrecognized';

/** The daemon instance a lifecycle request is addressed to; any other instance refuses it. */
export type DaemonLifecycleFence = Readonly<{
  pid: number;
  /** Null when the daemon could not prove its start time, as its `daemon.json` records. */
  processStartTime: string | null;
}>;

/**
 * What a daemon holds, and the census a busy refusal carries so a caller knows what to wait for.
 * A quiesce leaves only when all four counts are zero and it is not still starting up, because before
 * that it has no drain path to run.
 */
export type DaemonLifecycleCensus = Readonly<{
  /** True from process start until the daemon can drain. */
  startingUp: boolean;
  inFlightRequests: number;
  sessions: number;
  repairSessions: number;
  leases: number;
}>;

/**
 * The quiesce request carries its fence in `input`, so a daemon refuses a request addressed to a
 * predecessor that reused its pid.
 */
export function buildDaemonLifecycleRequest(params: {
  token: string;
  fence: DaemonLifecycleFence;
  requestId: string;
}): DaemonWireRequest {
  const { token, fence, requestId } = params;
  return {
    token,
    session: 'default',
    command: DAEMON_QUIESCE_COMMAND,
    positionals: [],
    input: { pid: fence.pid, processStartTime: fence.processStartTime },
    meta: { requestId },
  };
}

export function readDaemonLifecycleFence(input: unknown): DaemonLifecycleFence | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const { pid, processStartTime } = input as Record<string, unknown>;
  if (!Number.isInteger(pid)) return undefined;
  if (processStartTime !== null && typeof processStartTime !== 'string') return undefined;
  return { pid: pid as number, processStartTime };
}

/**
 * Refuses a remote `--save-script` before it is sent to a daemon that cannot deliver session
 * scripts (ADR 0016), because such a daemon records to its own disk and never delivers.
 */
export function assertScriptArtifactsCapability(capabilities: readonly string[] | undefined): void {
  if (capabilities?.includes('script-artifacts')) return;
  throw new AppError('INVALID_ARGS', 'The remote daemon cannot deliver session scripts.', {
    reason: 'remote_script_artifacts_unsupported',
    daemonRequestSent: false,
    hint: 'Upgrade the daemon that owns the session. Through a proxy, the upstream daemon must report the script-artifacts capability in its /health response.',
  });
}

export function readDaemonCapabilities(value: unknown): readonly DaemonCapability[] {
  if (!Array.isArray(value)) return [];
  return DAEMON_CAPABILITIES.filter((capability) => value.includes(capability));
}

export function readDaemonLifecycleCensus(details: unknown): DaemonLifecycleCensus | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const { startingUp, inFlightRequests, sessions, repairSessions, leases } = details as Record<
    string,
    unknown
  >;
  if (startingUp !== undefined && typeof startingUp !== 'boolean') return undefined;
  const counts = [inFlightRequests, sessions, repairSessions, leases];
  if (!counts.every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) {
    return undefined;
  }
  return {
    startingUp: startingUp === true,
    inFlightRequests: inFlightRequests as number,
    sessions: sessions as number,
    repairSessions: repairSessions as number,
    leases: leases as number,
  };
}

/** Directs embedded runtime callers to the host that owns close. */
export function embeddedCloseHint(pid: number | undefined): string {
  return `${pid === undefined ? 'The runtime is owned by its host process.' : `The runtime is owned by host process ${pid}.`} Close it there with the handle returned by startAgentDevice(). Recovery with daemon stop or ensureDaemon() for this state directory retires the abandoned registration only when the recorded host lifetime has provably exited.`;
}
