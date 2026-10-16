import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expandUserHomePath, resolveUserPath } from '@agent-device/host-kit/file';
import { findProjectRoot, isSourceCheckoutProjectRoot } from '@agent-device/host-kit/version';
import { type EnvMap } from '@agent-device/kernel/source-value';

import type { DaemonWireRequest } from '@agent-device/contracts/command';
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
  return resolveUserPath(value, { env: options.env });
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

// The quiesce request is how a client asks an idle daemon to leave so a compatible one can take
// its state directory. The client and the daemon share this vocabulary, so neither owns it.

/** What a daemon can do beyond the base RPC contract, published in its `daemon.json`. */
export const DAEMON_CAPABILITIES = ['quiesce'] as const;
export type DaemonCapability = (typeof DAEMON_CAPABILITIES)[number];

export const DAEMON_QUIESCE_COMMAND = 'daemon_quiesce';

/** The reason a daemon gives every request it refuses once it has begun to leave. */
export const DAEMON_SHUTTING_DOWN_REASON = 'daemon_shutting_down';

export const DAEMON_QUIESCE_REASONS = {
  busy: 'daemon-busy',
  instanceMismatch: 'daemon-instance-mismatch',
} as const;

/** The daemon instance a quiesce request is addressed to; any other instance refuses it. */
export type DaemonQuiesceFence = Readonly<{
  pid: number;
  /** Null when the daemon could not prove its start time, as its `daemon.json` records. */
  processStartTime: string | null;
}>;

/**
 * What a daemon holds. It leaves a quiesce request only when all four counts are zero and it is
 * not still starting up, because before that it has no drain path to run.
 */
export type DaemonQuiesceCensus = Readonly<{
  /** True from process start until the daemon can drain. */
  startingUp: boolean;
  inFlightRequests: number;
  sessions: number;
  repairSessions: number;
  leases: number;
}>;

export function buildDaemonQuiesceRequest(params: {
  token: string;
  fence: DaemonQuiesceFence;
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

export function readDaemonQuiesceFence(input: unknown): DaemonQuiesceFence | undefined {
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

export function readDaemonQuiesceCensus(details: unknown): DaemonQuiesceCensus | undefined {
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
