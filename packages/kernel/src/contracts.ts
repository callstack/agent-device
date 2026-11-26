import { AppError, type DaemonError } from './errors.ts';

export type { AppErrorCode } from './errors.ts';
export { defaultHintForCode } from './errors.ts';
import type { PlatformSelector, PublicPlatform } from './device.ts';

const SESSION_RUNTIME_PLATFORMS = ['ios', 'android', 'harmonyos'] as const;
export type SessionRuntimePlatform = (typeof SESSION_RUNTIME_PLATFORMS)[number];

export function isSessionRuntimePlatform(value: unknown): value is SessionRuntimePlatform {
  return SESSION_RUNTIME_PLATFORMS.some((platform) => platform === value);
}

export type SessionRuntimeHints = {
  platform?: SessionRuntimePlatform;
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
    };

const DAEMON_LOCK_POLICIES = ['reject', 'strip'] as const;
export type DaemonLockPolicy = (typeof DAEMON_LOCK_POLICIES)[number];
export const LEASE_BACKENDS = [
  'ios-simulator',
  'ios-instance',
  'android-instance',
  'harmonyos-instance',
  'macos-app',
] as const;
export type LeaseBackend = (typeof LEASE_BACKENDS)[number];

/** The lease backend `raw` names, ignoring case and surrounding space; `undefined` for none. */
export function readLeaseBackend(raw: string | undefined): LeaseBackend | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  return LEASE_BACKENDS.find((entry) => entry === value);
}

export function canonicalLeaseProvider(raw: string | undefined): string | undefined {
  return raw?.trim() || undefined;
}

export function readLeaseProvider(raw: unknown): string | undefined {
  const value = canonicalLeaseProvider(typeof raw === 'string' ? raw : undefined) ?? '';
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value) ? value : undefined;
}

export function normalizeLeaseProvider(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const provider = readLeaseProvider(raw);
  if (provider) return provider;
  throw new AppError(
    'INVALID_ARGS',
    'Invalid lease provider. Use 1-64 chars: letters, numbers, dot, underscore, hyphen.',
  );
}

// Which lease backend rents a device on each platform the remote lease layer can hold. `ios-simulator`
// is a backend-specific runner guard rather than something a platform selector names, and the
// platforms with no remote lease backend (`vega`, `linux`, `web`) — and the macOS desktop host — map
// to no backend at all, so a request for one fails on the missing backend instead of renting a
// device no provider owns. Keyed on the `--platform` selector axis: callers holding a `DeviceInfo`
// project it with `publicPlatformString` first, which is the axis #2962 mixed up.
const LEASE_BACKEND_BY_PLATFORM: Partial<Record<PlatformSelector, LeaseBackend>> = {
  ios: 'ios-instance',
  android: 'android-instance',
  harmonyos: 'harmonyos-instance',
};

/**
 * Maps a platform to the lease backend that rents it. The CLI reads it for `--platform`/
 * `--lease-backend` resolution and the remote connection reads it for the device it just resolved.
 * Both previously keyed their own copy off a platform axis, which is where #2962 started; a further
 * copy in `connect limrun` validation is tracked for follow-up.
 */
export function leaseBackendForPlatform(
  platform: PlatformSelector | undefined,
): LeaseBackend | undefined {
  return platform === undefined ? undefined : LEASE_BACKEND_BY_PLATFORM[platform];
}

/**
 * The public leaf platform a lease backend rents devices on — the inverse of
 * {@link leaseBackendForPlatform} for the backends that name a platform rather than a runner guard.
 *
 * A connection binds a platform at the same moment it binds a lease, and the lease is the stronger
 * evidence: it names the backend that is actually holding the device. `ios-simulator` maps to no
 * leaf because it is a runner/process guard below device leases, not a platform a selector names.
 *
 * Derived from the forward table rather than written beside it, so the two axes cannot drift, and held
 * in a `Map` because a `leaseBackend` reaching here can be any string an older binary left on disk: a
 * plain object would answer `constructor` and friends with an inherited function, which is a platform
 * nobody rents.
 */
const PLATFORM_BY_LEASE_BACKEND = new Map<string, PublicPlatform>([
  ...Object.entries(LEASE_BACKEND_BY_PLATFORM).flatMap(([platform, backend]) =>
    backend === undefined ? [] : [[backend, platform as PublicPlatform] as const],
  ),
  // A `macos-app` lease rents one app on the macOS host, never the host itself, so no platform
  // selector resolves to it: only a host administrator allocates one, and its client names it.
  ['macos-app', 'macos'],
]);

export function platformForLeaseBackend(backend: string): PublicPlatform | undefined {
  return PLATFORM_BY_LEASE_BACKEND.get(backend);
}

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
  /** The client's `DEVELOPER_DIR`, applied to the commands a local daemon spawns for this request. */
  developerDir?: string;
  sessionExplicit?: boolean;
  tenantId?: string;
  runId?: string;
  leaseId?: string;
  leaseTtlMs?: number;
  leaseRetainOnClose?: boolean;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  /** A local caller's digest of its lease-provider credential variables, compared on allocation. */
  providerCredentialFingerprint?: string;
  sessionIsolation?: SessionIsolationMode;
  uploadedArtifactId?: string;
  clientArtifactPaths?: Record<string, string>;
  /** The ID a remote client minted for its `open --save-script`; each script version carries it. */
  scriptPublicationId?: string;
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
  | 'screen-recording-contact-sheet'
  | 'screen-recording-telemetry'
  | 'trace-log'
  | 'test-artifacts'
  | 'session-script';

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
  /** The remote `open --save-script` publication a `session-script` artifact belongs to. */
  scriptPublicationId?: string;
  /** A `session-script` version number. Versions of one recording grow, so the newest one wins. */
  scriptRevision?: number;
};

/**
 * A remote recording's script version that was not delivered (ADR 0016). The action that recorded
 * it keeps its success; the response carries this beside a warning with the same text.
 */
export type ScriptDeliveryFailure = {
  reason: 'script_delivery_failed';
  publicationId: string;
  message: string;
  hint: string;
  /** Why the client could not download or save the version, when the client found the failure. */
  cause?: string;
};

/**
 * Reads a response's `scriptDeliveryFailure` (ADR 0016). A response that carries no such record, or
 * one the field contract does not describe, answers `undefined`: no surface acts on a half-shaped
 * failure, and every surface that shows one shows it through this reader.
 */
export function readScriptDeliveryFailure(
  data: Record<string, unknown> | undefined,
): ScriptDeliveryFailure | undefined {
  const failure = data?.scriptDeliveryFailure;
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return undefined;
  const { reason, publicationId, message, hint, cause } = failure as Partial<ScriptDeliveryFailure>;
  if (
    reason !== 'script_delivery_failed' ||
    typeof publicationId !== 'string' ||
    typeof message !== 'string' ||
    typeof hint !== 'string' ||
    (cause !== undefined && typeof cause !== 'string')
  ) {
    return undefined;
  }
  return { reason, publicationId, message, hint, ...(cause === undefined ? {} : { cause }) };
}

/**
 * What one daemon request delivered for a remote script recording (ADR 0016, #4595). A composite
 * request (a `batch`) collects the script effects of its nested steps and answers ONE of these on
 * its own reply, in `data` on success and in `error.details` on failure, so a client never
 * reconstructs delivery from step results.
 *
 * `version` is the newest applicable full-script version of the recording — the client downloads at
 * most it, once. `close` names the 1-based step of the submitted plan that ended the recording; a
 * client retires its record only for a close its own plan carries. `failures` are the typed
 * delivery failures the request owns, each paired with a warning of the same text.
 */
export type ScriptDeliveryReceipt = {
  publicationId: string;
  version?: DaemonArtifact;
  close?: { step: number };
  failures?: ScriptDeliveryFailure[];
};

/** How many `failures` one receipt may name; a receipt naming more authorizes nothing. */
const SCRIPT_DELIVERY_RECEIPT_MAX_FAILURES = 1000;

const SCRIPT_DELIVERY_RECEIPT_MAX_STRING_LENGTH = 4096;

/**
 * Reads the delivery receipt a response names (ADR 0016, #4595). A receipt the field contract does
 * not describe in FULL authorizes nothing and answers `undefined`: a half-shaped `version`, `close`
 * or `failures` entry is not repaired, because a client that acts on part of a receipt it cannot
 * account for is exactly how a batch delivered the wrong version before.
 */
export function readScriptDeliveryReceipt(
  response: DaemonResponse,
): ScriptDeliveryReceipt | undefined {
  const body: Record<string, unknown> | undefined = response.ok
    ? response.data
    : response.error.details;
  const receipt = body?.scriptDeliveryReceipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return undefined;
  const { publicationId, version, close, failures } = receipt as Partial<ScriptDeliveryReceipt>;
  if (!isReceiptPublicationId(publicationId)) return undefined;
  if (version !== undefined && !isScriptVersionArtifact(version, publicationId)) return undefined;
  if (close !== undefined && !isReceiptClose(close)) return undefined;
  if (failures !== undefined && !readsAsReceiptFailures(failures, publicationId)) return undefined;
  return {
    publicationId,
    ...(version === undefined ? {} : { version }),
    ...(close === undefined ? {} : { close: { step: close.step } }),
    ...(failures === undefined
      ? {}
      : { failures: (failures as readonly ScriptDeliveryFailure[]).slice() }),
  };
}

function isReceiptPublicationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    withinReceiptStringBudget(value)
  );
}

function withinReceiptStringBudget(value: string): boolean {
  return value.length <= SCRIPT_DELIVERY_RECEIPT_MAX_STRING_LENGTH;
}

function isReceiptClose(close: unknown): close is { step: number } {
  if (!close || typeof close !== 'object' || Array.isArray(close)) return false;
  const step = (close as { step?: unknown }).step;
  return typeof step === 'number' && Number.isSafeInteger(step) && step >= 1;
}

/**
 * Whether every named entry is a delivery failure of the recording the receipt names. The bound is
 * checked before any entry is read, so an oversized answer costs nothing beyond its own size.
 */
function readsAsReceiptFailures(
  failures: unknown,
  publicationId: string,
): failures is readonly ScriptDeliveryFailure[] {
  if (!Array.isArray(failures) || failures.length > SCRIPT_DELIVERY_RECEIPT_MAX_FAILURES) {
    return false;
  }
  return failures.every((failure) => {
    const read = readScriptDeliveryFailure({ scriptDeliveryFailure: failure });
    if (read === undefined || read.publicationId !== publicationId) return false;
    return (
      withinReceiptStringBudget(read.message) &&
      withinReceiptStringBudget(read.hint) &&
      (read.cause === undefined || withinReceiptStringBudget(read.cause))
    );
  });
}

/** Whether `version` is a `session-script` version of the recording the receipt names. */
function isScriptVersionArtifact(
  version: unknown,
  publicationId: string,
): version is DaemonArtifact {
  if (!version || typeof version !== 'object' || Array.isArray(version)) return false;
  const artifact = version as Partial<DaemonArtifact>;
  return (
    artifact.field === 'savedScript' &&
    artifact.artifactType === 'session-script' &&
    typeof artifact.artifactId === 'string' &&
    withinReceiptStringBudget(artifact.artifactId) &&
    artifact.scriptPublicationId === publicationId &&
    Number.isSafeInteger(artifact.scriptRevision) &&
    (artifact.scriptRevision as number) > 0
  );
}

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

export type DaemonResponse =
  | {
      ok: true;
      data?: DaemonResponseData;
    }
  | {
      ok: false;
      error: DaemonError;
    };

export type DaemonFailureResponse = Extract<DaemonResponse, { ok: false }>;

/**
 * The one `DaemonResponse` failure constructor. Declared beside the response type so a
 * command-side port that returns — rather than throws — a dispatch failure builds the same
 * wire shape as a daemon handler without importing the daemon.
 */
export function errorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  options?: { hint?: string; retriable?: boolean },
): DaemonFailureResponse {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(options?.hint ? { hint: options.hint } : {}),
      ...(options?.retriable === undefined ? {} : { retriable: options.retriable }),
      ...(details ? { details } : {}),
    },
  };
}

export const NO_ACTIVE_SESSION_MESSAGE =
  'No active session. Run agent-device open <app> first, then retry the command.';

/**
 * Shared no-active-session failure used by handlers that require
 * an open session before dispatching.
 */
export function noActiveSessionError(): DaemonFailureResponse {
  return errorResponse('SESSION_NOT_FOUND', NO_ACTIVE_SESSION_MESSAGE);
}

export type JsonRpcId = string | number | null;

export type JsonRpcRequestEnvelope<TParams = unknown> = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: TParams;
};

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

/**
 * Reads `record[key]` as an optional array of strings, the same check `commandRpcParamsSchema`
 * applies to HTTP positionals. Throws an `Error` naming the offending element, such as
 * `$.positionals[1]: Expected a string`.
 */
export function readOptionalStringArrayField(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  return optionalStringArray(record, key, '$');
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
    platform: optionalEnum(record, 'platform', SESSION_RUNTIME_PLATFORMS, path),
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
  if (value === undefined || value === null) return value;
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
