import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expandUserHomePath, resolveUserPath } from '@agent-device/host-kit/file';
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
export const DAEMON_CAPABILITIES = ['quiesce'] as const;
export type DaemonCapability = (typeof DAEMON_CAPABILITIES)[number];

/**
 * Who owns the process a registration names, and so who may end it.
 *
 * - `detached`: the daemon is its own process, which a stop may signal. This is what a record that
 *   predates the field names.
 * - `embedded`: the host that started the runtime owns the process. Nothing in the central
 *   lifecycle signals that PID, not even hung recovery or a forced stop: the host closes the
 *   runtime through its own close, and an external stop refuses it.
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

/** The command carrying the fenced lifecycle request. */
export const DAEMON_LIFECYCLE_COMMANDS = {
  /** Stop if idle: refuses while the daemon holds a request, a session, or a lease. */
  quiesce: 'daemon_quiesce',
} as const;
export type DaemonLifecycleMode = keyof typeof DAEMON_LIFECYCLE_COMMANDS;

/**
 * The lifecycle mode `command` names, or `undefined` for every request that is not one. Compared
 * explicitly, because a lookup in an object would answer for a command like `toString` too.
 */
export function readDaemonLifecycleMode(command: string): DaemonLifecycleMode | undefined {
  switch (command) {
    case DAEMON_LIFECYCLE_COMMANDS.quiesce:
      return 'quiesce';
    default:
      return undefined;
  }
}

/** The reason a daemon gives every request it refuses once it has begun to leave. */
export const DAEMON_SHUTTING_DOWN_REASON = 'daemon_shutting_down';

/** Why a daemon refuses a lifecycle request: one entry per rule the admission seam enforces. */
export const DAEMON_LIFECYCLE_REASONS = {
  /** A quiesce found the daemon holding work, so nothing was accepted. */
  busy: 'daemon-busy',
  /** The request names a different daemon instance than the one answering it. */
  instanceMismatch: 'daemon-instance-mismatch',
  /** A quiesce was refused because a host owns this runtime and ends it through its own close. */
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
 * A quiesce leaves only when all four counts are zero and it is not still starting up.
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
 * The request that asks the fenced instance to leave. Both modes carry the fence in `input`, so a
 * daemon refuses a request addressed to a predecessor that reused its pid.
 */
export function buildDaemonLifecycleRequest(params: {
  mode: DaemonLifecycleMode;
  token: string;
  fence: DaemonLifecycleFence;
  requestId: string;
}): DaemonWireRequest {
  const { mode, token, fence, requestId } = params;
  return {
    token,
    session: 'default',
    command: DAEMON_LIFECYCLE_COMMANDS[mode],
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
