import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  admitPrivateRoot,
  expandUserHomePath,
  resolveUserPath,
  type PrivateRootAdmission,
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
  // Refused before expansion, and only for the host's own separators: a POSIX file name may hold `\`.
  if (value.split(process.platform === 'win32' ? /[\\/]/ : '/').includes('..')) {
    throw unsafeStateRoot(value, value, 'parent-step');
  }
  const expanded = expandUserHomePath(value, { env: options.env });
  if (path.isAbsolute(expanded)) return expanded;
  if (options.cwd === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      `State dir "${value}" is relative and no working directory was given.`,
      {
        reason: 'relative_state_dir_without_cwd',
      },
    );
  }
  return resolveUserPath(value, { env: options.env, cwd: options.cwd });
}

const MANAGED_STATE_DIRS = ['sessions', path.join('sessions', 'remote-scripts')] as const;

/** The one reason every refusal answers with; callers branch on it, never on text. */
const DAEMON_STATE_ROOT_UNSAFE_REASON = 'daemon_state_root_unsafe';

const MOVE_STATE_DIR_FIX =
  'Point AGENT_DEVICE_STATE_DIR (or --state-dir) at a real private directory you own, such as "$HOME/.agent-device".';
const UNSAFE_ANCESTRY = 'is writable by group or others, so another account can steer the path.';
const DRIVE_ABSOLUTE_FIX = String.raw`Use a drive-absolute path, such as C:\Users\you\.agent-device.`;

const STATE_ROOT_PROBLEMS = {
  symlink: ['is a symbolic link.', MOVE_STATE_DIR_FIX],
  'foreign-owner': ['is owned by another local user.', MOVE_STATE_DIR_FIX],
  'group-or-other-writable-ancestor': [UNSAFE_ANCESTRY, MOVE_STATE_DIR_FIX],
  'not-private': ['is open to accounts besides its owner.', 'chmod 700'],
  'not-a-directory': ['is not a directory.', MOVE_STATE_DIR_FIX],
  unavailable: ['could not be checked or created.', MOVE_STATE_DIR_FIX],
  'parent-step': ['steps out of its parent with "..".', 'Name a real path, without a `..` step.'],
  'unsupported-windows-path': ['is not a supported Windows path shape.', DRIVE_ABSOLUTE_FIX],
} as const;

type DaemonStateRootProblem = keyof typeof STATE_ROOT_PROBLEMS;

/** Words the walk's verdict for an operator. What the walk could not decide is `unavailable`. */
function problemForExposure(
  exposure: Extract<PrivateRootAdmission, { status: 'refused' }>['exposure'],
): DaemonStateRootProblem {
  if (exposure === 'planted_link' || exposure === 'link_loop_exceeded') return 'symlink';
  if (exposure === 'foreign_owned') return 'foreign-owner';
  if (exposure === 'not_private') return 'not-private';
  if (exposure === 'not_a_directory' || exposure === 'entry_appeared') return 'not-a-directory';
  if (exposure === 'world_writable' || exposure === 'shared_group_writable')
    return 'group-or-other-writable-ancestor';
  return 'unavailable';
}

/**
 * Admits the daemon's state root once, before an operation's first state-directory I/O. `establish` creates a
 * missing root and `repair` creates nothing; both close an owned root the umask left open (#4649). A refusal
 * answers with `daemon_state_root_unsafe`. On Windows only the path shape is judged.
 */
export function admitDaemonStateRoot(options: {
  paths: DaemonPaths;
  mode: 'repair' | 'establish';
}): void {
  const { baseDir } = options.paths;
  if (process.platform === 'win32') {
    if (windowsStatePathProblem(baseDir))
      throw unsafeStateRoot(baseDir, baseDir, 'unsupported-windows-path');
    // Nothing else creates this directory, and mode bits answer nothing about accounts here.
    if (options.mode === 'establish') fs.mkdirSync(baseDir, { recursive: true });
    return;
  }
  const admitted = admitPrivateRoot({
    rootPath: baseDir,
    mode: options.mode,
    managedDirs: MANAGED_STATE_DIRS,
  });
  if (admitted.status !== 'refused') return;
  throw unsafeStateRoot(baseDir, admitted.component, problemForExposure(admitted.exposure));
}

/** The Windows shape rule, asked of `path.win32` whatever the host runs: a local drive-absolute route. */
function windowsStatePathProblem(stateDir: string): boolean {
  const rest = /^[A-Za-z]:[\\/](.*)$/.exec(path.win32.normalize(stateDir))?.[1];
  return rest === undefined || rest.includes(':');
}

function unsafeStateRoot(
  stateDir: string,
  component: string,
  problem: DaemonStateRootProblem,
): AppError {
  const [cause, step] = STATE_ROOT_PROBLEMS[problem];
  const fix = problem === 'not-private' ? `${step} ${component}` : step;
  return new AppError(
    'COMMAND_FAILED',
    `Refusing to use the daemon state directory ${stateDir}: ${component} ${cause}`,
    { reason: DAEMON_STATE_ROOT_UNSAFE_REASON, stateDir, component, problem, fix, hint: fix },
  );
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
