export type { AppErrorCode } from './errors.ts';
export { defaultHintForCode, normalizeError } from './errors.ts';
import type { PlatformSelector } from './device.ts';

export type SessionRuntimeHints = {
  platform?: 'ios' | 'android';
  metroHost?: string;
  metroPort?: number;
  bundleUrl?: string;
  launchUrl?: string;
};

export type DaemonInstallSource =
  | {
      kind: 'url';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      kind: 'path';
      path: string;
    }
  | ({
      kind: 'github-actions-artifact';
      owner: string;
      repo: string;
    } & (
      | {
          artifactId: number;
        }
      | {
          runId: number;
          artifactName: string;
        }
      | {
          artifactName: string;
        }
    ));

const DAEMON_LOCK_POLICIES = ['reject', 'strip'] as const;
export type DaemonLockPolicy = (typeof DAEMON_LOCK_POLICIES)[number];
const LEASE_BACKENDS = ['ios-simulator', 'ios-instance', 'android-instance'] as const;
export type LeaseBackend = (typeof LEASE_BACKENDS)[number];
const DAEMON_SERVER_MODES = ['socket', 'http', 'dual'] as const;
export type DaemonServerMode = (typeof DAEMON_SERVER_MODES)[number];
const DAEMON_TRANSPORT_PREFERENCES = ['auto', 'socket', 'http'] as const;
export type DaemonTransportPreference = (typeof DAEMON_TRANSPORT_PREFERENCES)[number];
const SESSION_ISOLATION_MODES = ['none', 'tenant'] as const;
export type SessionIsolationMode = (typeof SESSION_ISOLATION_MODES)[number];
export const NETWORK_INCLUDE_MODES = ['summary', 'headers', 'body', 'all'] as const;
export type NetworkIncludeMode = (typeof NETWORK_INCLUDE_MODES)[number];

// Agent-cost leveled response views (Phase 4). `default` == today's exact wire
// shape (Maestro `.ad` recompare safe); `digest` is a token-cheap view; `full`
// is the richest view (== default until a command surfaces extra detail).
export const RESPONSE_LEVELS = ['digest', 'default', 'full'] as const;
export type ResponseLevel = (typeof RESPONSE_LEVELS)[number];

/**
 * Whether a response level changes the wire shape from today's default. Used by
 * the client/CLI/MCP rendering boundaries to pass a leveled payload through
 * verbatim instead of running it through default-shape formatters.
 */
export function isNonDefaultResponseLevel(level: ResponseLevel | undefined): boolean {
  return level !== undefined && level !== 'default';
}

export type DaemonRequestMeta = {
  requestId?: string;
  debug?: boolean;
  includeCost?: boolean;
  responseLevel?: ResponseLevel;
  cwd?: string;
  sessionExplicit?: boolean;
  tenantId?: string;
  runId?: string;
  leaseId?: string;
  leaseTtlMs?: number;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  sessionIsolation?: SessionIsolationMode;
  uploadedArtifactId?: string;
  clientArtifactPaths?: Record<string, string>;
  installSource?: DaemonInstallSource;
  retainMaterializedPaths?: boolean;
  materializedPathRetentionMs?: number;
  materializationId?: string;
  lockPolicy?: DaemonLockPolicy;
  lockPlatform?: PlatformSelector;
  requestProgress?: 'replay-test' | 'command';
};

export type DaemonRequest = {
  token?: string;
  session?: string;
  command: string;
  positionals: string[];
  input?: Record<string, unknown>;
  flags?: Record<string, unknown>;
  runtime?: SessionRuntimeHints;
  meta?: DaemonRequestMeta;
};

export type DaemonArtifactKnownType =
  | 'screenshot'
  | 'screenshot-diff'
  | 'screen-recording'
  | 'screen-recording-chunk'
  | 'screen-recording-telemetry'
  | 'trace-log';

export type DaemonArtifactType = DaemonArtifactKnownType | (string & {});

export type DaemonArtifact = {
  field: string;
  // Optional on the wire: missing metadata is valid, JSON drops undefined, and
  // remote/older daemons may omit the field entirely. Producer-owned APIs
  // (reserveOutput, trackDownloadableArtifact) keep the required
  // `DaemonArtifactType | undefined` form so artifact owners must decide.
  artifactType?: DaemonArtifactType;
  artifactId?: string;
  fileName?: string;
  localPath?: string;
  path?: string;
};

export type ResponseCost = {
  wallClockMs: number;
  // Number of real iOS-runner round-trips made while serving the request (the
  // `ios_runner_command_send` + `ios_runner_readiness_preflight` diagnostic
  // phases). Always present when cost is included; 0 when no runner was hit.
  runnerRoundTrips: number;
  // Number of UI/accessibility nodes in the response, when the command returns a
  // node tree (e.g. snapshot). Absent for commands that produce no nodes, so an
  // agent can size a snapshot before re-fetching at a different depth/scope.
  nodeCount?: number;
};

export type DaemonResponseData = Record<string, unknown> & {
  artifacts?: DaemonArtifact[];
  cost?: ResponseCost;
};

export type DaemonError = {
  code: string;
  message: string;
  hint?: string;
  diagnosticId?: string;
  logPath?: string;
  details?: Record<string, unknown>;
  /**
   * Machine-readable typed-error signals (Phase 2). Additive: present only when
   * derivable, so the default error wire shape is unchanged.
   *
   * `retriable` flags a transient failure an agent should retry (vs. a
   * deterministic one where a retry is wasted). `supportedOn` lists the platform
   * families that DO support the command (derived from the capability matrix),
   * surfaced on platform-mismatch errors so an agent self-corrects without a
   * wasted round-trip.
   */
  retriable?: boolean;
  supportedOn?: string;
};

export type DaemonResponse =
  | {
      ok: true;
      data?: DaemonResponseData;
    }
  | {
      ok: false;
      error: DaemonError;
    };

export type LeaseAllocatePayload = {
  token?: string;
  session?: string;
  tenantId?: string;
  tenant?: string;
  runId?: string;
  ttlMs?: number;
  backend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type LeaseHeartbeatPayload = {
  token?: string;
  session?: string;
  tenantId?: string;
  tenant?: string;
  runId?: string;
  leaseId?: string;
  ttlMs?: number;
  backend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type LeaseReleasePayload = {
  token?: string;
  session?: string;
  tenantId?: string;
  tenant?: string;
  runId?: string;
  leaseId?: string;
  backend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type JsonRpcId = string | number | null;

export type JsonRpcRequestEnvelope<TParams = unknown> = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: TParams;
};

export { centerOfRect } from './snapshot.ts';
export type { Rect, SnapshotNode } from './snapshot.ts';

type RuntimeSchema<T> = {
  parse(input: unknown): T;
};

// Keep the public contracts entrypoint dependency-free. These schemas exist so bridge/cloud
// consumers can validate shared payloads without pulling in an additional runtime library.
function schema<T>(parse: (input: unknown, path: string) => T): RuntimeSchema<T> {
  return {
    parse(input: unknown): T {
      return parse(input, '$');
    },
  };
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function expectObject(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(path, 'Expected an object');
  }
  return input as Record<string, unknown>;
}

function expectString(input: unknown, path: string): string {
  if (typeof input !== 'string') {
    fail(path, 'Expected a string');
  }
  return input;
}

function expectInteger(input: unknown, path: string): number {
  if (!Number.isInteger(input)) {
    fail(path, 'Expected an integer');
  }
  return input as number;
}

function expectArray(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) {
    fail(path, 'Expected an array');
  }
  return input;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : expectString(value, `${path}.${key}`);
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const items = expectArray(value, `${path}.${key}`);
  return items.map((item, index) => expectString(item, `${path}.${key}[${String(index)}]`));
}

function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = record[key];
  return value === undefined ? undefined : expectInteger(value, `${path}.${key}`);
}

function optionalObject(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return value === undefined ? undefined : expectObject(value, `${path}.${key}`);
}

function optionalEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): T | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${path}.${key}`, `Expected one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export const daemonRuntimeSchema = schema<SessionRuntimeHints>((input, path) => {
  const record = expectObject(input, path);
  return {
    platform: optionalEnum(record, 'platform', ['ios', 'android'] as const, path),
    metroHost: optionalString(record, 'metroHost', path),
    metroPort: optionalInteger(record, 'metroPort', path),
    bundleUrl: optionalString(record, 'bundleUrl', path),
    launchUrl: optionalString(record, 'launchUrl', path),
  };
});

function parseJsonRpcId(
  record: Record<string, unknown>,
  path: string,
): string | number | null | undefined {
  const value = record.id;
  if (value === undefined || value === null) return value as null | undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    fail(`${path}.id`, 'Expected a string, number, or null');
  }
  return value;
}

export const jsonRpcRequestSchema = schema<JsonRpcRequestEnvelope>((input, path) => {
  const record = expectObject(input, path);
  return {
    jsonrpc: optionalString(record, 'jsonrpc', path),
    id: parseJsonRpcId(record, path),
    method: optionalString(record, 'method', path),
    params: record.params,
  };
});

export type CommandRpcParams = Partial<DaemonRequest>;

// Validates the `params` object of a command JSON-RPC request at the daemon's HTTP
// boundary so attacker-controlled wire input is parsed instead of force-cast. The
// control fields (token/session/command/positionals) are checked here; the richer
// flags/runtime/meta shapes are only confirmed to be objects and validated in depth
// by the session open handler downstream.
export const commandRpcParamsSchema = schema<CommandRpcParams>((input, path) => {
  const record = expectObject(input, path);
  return {
    token: optionalString(record, 'token', path),
    session: optionalString(record, 'session', path),
    command: optionalString(record, 'command', path),
    positionals: optionalStringArray(record, 'positionals', path),
    input: optionalObject(record, 'input', path),
    flags: optionalObject(record, 'flags', path),
    runtime: optionalObject(record, 'runtime', path) as SessionRuntimeHints | undefined,
    meta: optionalObject(record, 'meta', path) as DaemonRequestMeta | undefined,
  };
});
