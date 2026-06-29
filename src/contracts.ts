export type { AppErrorCode } from './kernel/errors.ts';
export { defaultHintForCode, normalizeError } from './kernel/errors.ts';
export type {
  DebugSymbolsCrashFrame,
  DebugSymbolsCrashSummary,
  DebugSymbolsImage,
  DebugSymbolsOptions,
  DebugSymbolsResult,
} from './contracts/debug-symbols.ts';
import type { PlatformSelector } from './kernel/device.ts';
import { PLATFORM_SELECTORS } from './kernel/device.ts';

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

export const DAEMON_LOCK_POLICIES = ['reject', 'strip'] as const;
export type DaemonLockPolicy = (typeof DAEMON_LOCK_POLICIES)[number];
export const LEASE_BACKENDS = ['ios-simulator', 'ios-instance', 'android-instance'] as const;
export type LeaseBackend = (typeof LEASE_BACKENDS)[number];
export const DAEMON_SERVER_MODES = ['socket', 'http', 'dual'] as const;
export type DaemonServerMode = (typeof DAEMON_SERVER_MODES)[number];
export const DAEMON_TRANSPORT_PREFERENCES = ['auto', 'socket', 'http'] as const;
export type DaemonTransportPreference = (typeof DAEMON_TRANSPORT_PREFERENCES)[number];
export const SESSION_ISOLATION_MODES = ['none', 'tenant'] as const;
export type SessionIsolationMode = (typeof SESSION_ISOLATION_MODES)[number];
export const NETWORK_INCLUDE_MODES = ['summary', 'headers', 'body', 'all'] as const;
export type NetworkIncludeMode = (typeof NETWORK_INCLUDE_MODES)[number];

export type DaemonRequestMeta = {
  requestId?: string;
  debug?: boolean;
  includeCost?: boolean;
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
  flags?: Record<string, unknown>;
  runtime?: SessionRuntimeHints;
  meta?: DaemonRequestMeta;
};

export type DaemonArtifact = {
  field: string;
  artifactId?: string;
  fileName?: string;
  localPath?: string;
  path?: string;
};

export type ResponseCost = {
  wallClockMs: number;
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

export { centerOfRect } from './kernel/snapshot.ts';
export type { Rect, SnapshotNode } from './kernel/snapshot.ts';

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

function expectNonEmptyString(input: unknown, path: string): string {
  const value = expectString(input, path).trim();
  if (!value) {
    fail(path, 'Expected a non-empty string');
  }
  return value;
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

function optionalDeviceKey(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = optionalString(record, key, path);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || value.length > 256 || !/^[\x20-\x7E]+$/.test(value)) {
    fail(`${path}.${key}`, 'Expected 1-256 printable characters');
  }
  return value;
}

function optionalIdentifier(
  record: Record<string, unknown>,
  key: string,
  path: string,
  maxLength: number,
): string | undefined {
  const value = optionalString(record, key, path);
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > maxLength || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    fail(
      `${path}.${key}`,
      `Expected 1-${String(maxLength)} chars: letters, numbers, dot, underscore, hyphen`,
    );
  }
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    fail(`${path}.${key}`, 'Expected a boolean');
  }
  return value;
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

function expectStringRecord(input: unknown, path: string): Record<string, string> {
  const record = expectObject(input, path);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = expectString(value, `${path}.${key}`);
  }
  return result;
}

function parseGitHubActionsArtifactInstallSource(
  record: Record<string, unknown>,
  path: string,
): DaemonInstallSource {
  const owner = expectNonEmptyString(record.owner, `${path}.owner`);
  const repo = expectNonEmptyString(record.repo, `${path}.repo`);
  const hasArtifactId = record.artifactId !== undefined;
  const hasRunId = record.runId !== undefined;
  const hasArtifactName = record.artifactName !== undefined;
  if (hasArtifactId && (hasRunId || hasArtifactName)) {
    fail(`${path}`, 'Expected either artifactId or artifactName, not both');
  }
  if (!hasArtifactId && hasRunId && !hasArtifactName) {
    fail(`${path}`, 'Expected artifactName when runId is specified');
  }
  if (!hasArtifactId && !hasArtifactName) {
    fail(`${path}`, 'Expected artifactId or artifactName');
  }
  if (hasArtifactId) {
    return {
      kind: 'github-actions-artifact',
      owner,
      repo,
      artifactId: expectInteger(record.artifactId, `${path}.artifactId`),
    };
  }
  return {
    kind: 'github-actions-artifact',
    owner,
    repo,
    ...(hasRunId ? { runId: expectInteger(record.runId, `${path}.runId`) } : {}),
    artifactName: expectNonEmptyString(record.artifactName, `${path}.artifactName`),
  };
}

function parseDaemonInstallSource(input: unknown, path: string): DaemonInstallSource {
  const record = expectObject(input, path);
  const kind = expectString(record.kind, `${path}.kind`);
  if (kind === 'url') {
    const url = expectString(record.url, `${path}.url`);
    const headers =
      record.headers === undefined
        ? undefined
        : expectStringRecord(record.headers, `${path}.headers`);
    return headers ? { kind, url, headers } : { kind, url };
  }
  if (kind === 'path') {
    return {
      kind,
      path: expectString(record.path, `${path}.path`),
    };
  }
  if (kind === 'github-actions-artifact') {
    return parseGitHubActionsArtifactInstallSource(record, path);
  }
  fail(`${path}.kind`, 'Expected "url", "path", or "github-actions-artifact"');
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

export const daemonCommandRequestSchema = schema<DaemonRequest>((input, path) => {
  const record = expectObject(input, path);
  const rawPositionals = expectArray(record.positionals, `${path}.positionals`);
  const meta = optionalObject(record, 'meta', path);
  return {
    token: optionalString(record, 'token', path),
    session: optionalString(record, 'session', path),
    command: expectString(record.command, `${path}.command`),
    positionals: rawPositionals.map((value, index) =>
      expectString(value, `${path}.positionals[${String(index)}]`),
    ),
    flags: optionalObject(record, 'flags', path),
    runtime: record.runtime === undefined ? undefined : daemonRuntimeSchema.parse(record.runtime),
    meta:
      meta === undefined
        ? undefined
        : {
            requestId: optionalString(meta, 'requestId', `${path}.meta`),
            debug: optionalBoolean(meta, 'debug', `${path}.meta`),
            includeCost: optionalBoolean(meta, 'includeCost', `${path}.meta`),
            cwd: optionalString(meta, 'cwd', `${path}.meta`),
            sessionExplicit: optionalBoolean(meta, 'sessionExplicit', `${path}.meta`),
            tenantId: optionalString(meta, 'tenantId', `${path}.meta`),
            runId: optionalString(meta, 'runId', `${path}.meta`),
            leaseId: optionalString(meta, 'leaseId', `${path}.meta`),
            leaseTtlMs: optionalInteger(meta, 'leaseTtlMs', `${path}.meta`),
            leaseBackend: optionalEnum(meta, 'leaseBackend', LEASE_BACKENDS, `${path}.meta`),
            leaseProvider: optionalIdentifier(meta, 'leaseProvider', `${path}.meta`, 64),
            deviceKey: optionalDeviceKey(meta, 'deviceKey', `${path}.meta`),
            clientId: optionalIdentifier(meta, 'clientId', `${path}.meta`, 128),
            sessionIsolation: optionalEnum(
              meta,
              'sessionIsolation',
              SESSION_ISOLATION_MODES,
              `${path}.meta`,
            ),
            uploadedArtifactId: optionalString(meta, 'uploadedArtifactId', `${path}.meta`),
            clientArtifactPaths:
              meta.clientArtifactPaths === undefined
                ? undefined
                : expectStringRecord(meta.clientArtifactPaths, `${path}.meta.clientArtifactPaths`),
            installSource:
              meta.installSource === undefined
                ? undefined
                : parseDaemonInstallSource(meta.installSource, `${path}.meta.installSource`),
            retainMaterializedPaths: optionalBoolean(
              meta,
              'retainMaterializedPaths',
              `${path}.meta`,
            ),
            materializedPathRetentionMs: optionalInteger(
              meta,
              'materializedPathRetentionMs',
              `${path}.meta`,
            ),
            materializationId: optionalString(meta, 'materializationId', `${path}.meta`),
            lockPolicy: optionalEnum(meta, 'lockPolicy', DAEMON_LOCK_POLICIES, `${path}.meta`),
            lockPlatform: optionalEnum(meta, 'lockPlatform', PLATFORM_SELECTORS, `${path}.meta`),
          },
  };
});

function parseLeaseCommon(
  input: unknown,
  path: string,
): {
  record: Record<string, unknown>;
  leaseId?: string;
  ttlMs?: number;
} {
  const record = expectObject(input, path);
  return {
    record,
    leaseId: optionalString(record, 'leaseId', path),
    ttlMs: optionalInteger(record, 'ttlMs', path),
  };
}

function parseLeaseScope(
  record: Record<string, unknown>,
  path: string,
): {
  token?: string;
  session?: string;
  tenantId?: string;
  tenant?: string;
  runId?: string;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
} {
  return {
    token: optionalString(record, 'token', path),
    session: optionalString(record, 'session', path),
    tenantId: optionalString(record, 'tenantId', path),
    tenant: optionalString(record, 'tenant', path),
    runId: optionalString(record, 'runId', path),
    leaseProvider: optionalIdentifier(record, 'leaseProvider', path, 64),
    deviceKey: optionalDeviceKey(record, 'deviceKey', path),
    clientId: optionalIdentifier(record, 'clientId', path, 128),
  };
}

export const leaseAllocateSchema = schema<LeaseAllocatePayload>((input, path) => {
  const record = expectObject(input, path);
  return {
    ...parseLeaseScope(record, path),
    ttlMs: optionalInteger(record, 'ttlMs', path),
    backend: optionalEnum(record, 'backend', LEASE_BACKENDS, path),
  };
});

export const leaseHeartbeatSchema = schema<LeaseHeartbeatPayload>((input, path) => {
  const parsed = parseLeaseCommon(input, path);
  return {
    ...parseLeaseScope(parsed.record, path),
    leaseId: parsed.leaseId,
    ttlMs: parsed.ttlMs,
    backend: optionalEnum(parsed.record, 'backend', LEASE_BACKENDS, path),
  };
});

export const leaseReleaseSchema = schema<LeaseReleasePayload>((input, path) => {
  const record = expectObject(input, path);
  if (record.ttlMs !== undefined) {
    fail(`${path}.ttlMs`, 'Unexpected field');
  }
  return {
    ...parseLeaseScope(record, path),
    leaseId: optionalString(record, 'leaseId', path),
    backend: optionalEnum(record, 'backend', LEASE_BACKENDS, path),
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
    flags: optionalObject(record, 'flags', path),
    runtime: optionalObject(record, 'runtime', path) as SessionRuntimeHints | undefined,
    meta: optionalObject(record, 'meta', path) as DaemonRequestMeta | undefined,
  };
});
