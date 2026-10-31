import type { DaemonResponse, LeaseBackend } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { stripUndefined } from '@agent-device/kernel/record';
import type { CloudProviderProfileFields } from './remote-config-fields.ts';
import type { CommandFlags } from './command-flags.ts';
import type { DaemonWireRequest } from './daemon-wire-request.ts';
import type { EndedLease, LeaseDevice, LeaseDeviceSpec } from './client-lease.ts';

const PROXY_LEASE_PROVIDER = 'proxy';
export const CLOUD_LEASE_PROVIDER = 'cloud';

/**
 * Lease providers that name a logical routing identity rather than a provider runtime. Any other
 * `leaseProvider` is backed by a registered runtime or is refused at allocation.
 */
const RUNTIME_LESS_LEASE_PROVIDERS: ReadonlySet<string> = new Set([
  PROXY_LEASE_PROVIDER,
  CLOUD_LEASE_PROVIDER,
]);

const REQUIRED_PROXY_LEASE_FIELDS = [
  'leaseId',
  'tenantId',
  'runId',
  'clientId',
  'deviceKey',
] as const satisfies readonly (keyof LeaseScope)[];

export type LeaseScope = {
  tenantId?: string;
  runId?: string;
  leaseId?: string;
  leaseTtlMs?: number;
  leaseRetainOnClose?: boolean;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type LeaseDiagnosticsContext = Omit<LeaseScope, 'leaseTtlMs' | 'leaseRetainOnClose'>;

export type LeaseRpcCommand = 'lease_allocate' | 'lease_heartbeat' | 'lease_release';

export type LeaseAllocateRequestScope = {
  tenantId: string;
  runId: string;
  leaseId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  ttlMs?: number;
  retainOnClose?: boolean;
};

export type LeaseScopedRequestScope = {
  leaseId: string;
  tenantId?: string;
  runId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  ttlMs?: number;
};

type LeaseRequestLike = {
  flags?: Record<string, unknown>;
  meta?: {
    tenantId?: string;
    runId?: string;
    leaseId?: string;
    leaseTtlMs?: number;
    leaseRetainOnClose?: boolean;
    leaseBackend?: LeaseBackend;
    leaseProvider?: string;
    deviceKey?: string;
    clientId?: string;
  };
};

type LeaseOptionsLike = {
  tenant?: string;
  runId?: string;
  leaseId?: string;
  leaseTtlMs?: number;
  ttlMs?: number;
  retainOnClose?: boolean;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  provider?: string;
  deviceKey?: string;
  clientId?: string;
};

export function leaseScopeFromRequest(req: LeaseRequestLike): LeaseScope {
  return stripUndefined({
    tenantId: req.meta?.tenantId ?? readFlagString(req.flags, 'tenant'),
    runId: req.meta?.runId ?? readFlagString(req.flags, 'runId'),
    leaseId: req.meta?.leaseId ?? readFlagString(req.flags, 'leaseId'),
    leaseTtlMs: req.meta?.leaseTtlMs,
    leaseRetainOnClose: req.meta?.leaseRetainOnClose,
    leaseBackend: req.meta?.leaseBackend,
    leaseProvider:
      req.meta?.leaseProvider ??
      readFlagString(req.flags, 'leaseProvider') ??
      readFlagString(req.flags, 'provider'),
    deviceKey: req.meta?.deviceKey ?? readFlagString(req.flags, 'deviceKey'),
    clientId: req.meta?.clientId ?? readFlagString(req.flags, 'clientId'),
  });
}

export function leaseScopeFromOptions(options: LeaseOptionsLike): LeaseScope {
  return stripUndefined({
    tenantId: options.tenant,
    runId: options.runId,
    leaseId: options.leaseId,
    leaseTtlMs: options.leaseTtlMs ?? options.ttlMs,
    leaseRetainOnClose: options.retainOnClose,
    leaseBackend: options.leaseBackend,
    leaseProvider: options.leaseProvider ?? options.provider,
    deviceKey: options.deviceKey,
    clientId: options.clientId,
  });
}

export function leaseScopeToRequestMeta(scope: LeaseScope): LeaseRequestLike['meta'] {
  return stripUndefined({
    tenantId: scope.tenantId,
    runId: scope.runId,
    leaseId: scope.leaseId,
    leaseTtlMs: scope.leaseTtlMs,
    leaseRetainOnClose: scope.leaseRetainOnClose,
    leaseBackend: scope.leaseBackend,
    leaseProvider: scope.leaseProvider,
    deviceKey: scope.deviceKey,
    clientId: scope.clientId,
  });
}

export function leaseScopeToCommandFlags(scope: LeaseScope): Record<string, unknown> {
  return stripUndefined({
    tenant: scope.tenantId,
    runId: scope.runId,
    leaseId: scope.leaseId,
    leaseBackend: scope.leaseBackend,
    leaseProvider: scope.leaseProvider,
    deviceKey: scope.deviceKey,
    clientId: scope.clientId,
  });
}

export function leaseScopeToAllocateRequest(scope: LeaseScope): LeaseAllocateRequestScope {
  return stripUndefined({
    tenantId: scope.tenantId ?? '',
    runId: scope.runId ?? '',
    leaseId: scope.leaseId,
    leaseBackend: scope.leaseBackend,
    leaseProvider: scope.leaseProvider,
    deviceKey: scope.deviceKey,
    clientId: scope.clientId,
    ttlMs: scope.leaseTtlMs,
    retainOnClose: scope.leaseRetainOnClose,
  }) as LeaseAllocateRequestScope;
}

export function leaseScopeToHeartbeatRequest(scope: LeaseScope): LeaseScopedRequestScope {
  return leaseScopeToScopedRequest(scope);
}

export function leaseScopeToReleaseRequest(
  scope: LeaseScope,
): Omit<LeaseScopedRequestScope, 'ttlMs'> {
  const { ttlMs: _ttlMs, ...request } = leaseScopeToScopedRequest(scope);
  return request;
}

export function leaseScopeToLeaseRpcParams(
  scope: LeaseScope,
  command: LeaseRpcCommand,
  options: {
    includeTokenParam: boolean;
    token?: string;
    session?: string;
  },
): Record<string, unknown> {
  const common = stripUndefined({
    ...(options.includeTokenParam ? { token: options.token } : {}),
    session: options.session,
    tenantId: scope.tenantId,
    runId: scope.runId,
    leaseProvider: scope.leaseProvider,
    clientId: scope.clientId,
    deviceKey: scope.deviceKey,
  });
  switch (command) {
    case 'lease_allocate':
      return {
        ...common,
        ...stripUndefined({
          leaseId: scope.leaseId,
          ttlMs: scope.leaseTtlMs,
          retainOnClose: scope.leaseRetainOnClose,
          backend: scope.leaseBackend,
        }),
      };
    case 'lease_heartbeat':
      return {
        ...common,
        ...stripUndefined({
          leaseId: scope.leaseId,
          ttlMs: scope.leaseTtlMs,
        }),
      };
    case 'lease_release':
      return {
        ...common,
        ...stripUndefined({
          leaseId: scope.leaseId,
        }),
      };
  }
}

/**
 * Request flags that must travel with `lease_allocate` so the daemon's lease-lifecycle provider can
 * prepare the session — device selection, the app/os, the session-naming fields, and the configured
 * device-feature and AWS knobs. The line transport forwards the whole request and these arrive for
 * free; the compact lease envelope is the only projection that has to name them, so the client's
 * producer and the daemon's consumer read the SAME list and cannot drop a sibling the provider needs.
 */
const LEASE_ALLOCATE_PROVIDER_FLAG_KEYS = [
  // Device selection the lease-lifecycle provider needs to create the session, and a proxy daemon
  // needs to pick the device when the request names no `deviceKey`.
  'platform',
  'target',
  'device',
  'udid',
  'serial',
  'iosSimulatorDeviceSet',
  'androidDeviceAllowlist',
  // The Cloud provider profile fields; pinned exhaustive against that vocabulary below.
  'providerApp',
  'providerOsVersion',
  'providerDeviceType',
  'providerProject',
  'providerBuild',
  'providerSessionName',
  'providerDeviceOrientation',
  'providerGeoLocation',
  'providerTimezone',
  'providerAppiumVersion',
  'providerLanguage',
  'providerLocale',
  'providerNetworkProfile',
  'providerCustomNetwork',
  'providerNoResignApp',
  'providerNetworkLogs',
  'providerNetworkHosts',
  'awsProjectArn',
  'awsDeviceArn',
  'awsAppArn',
  'awsRegion',
  'awsInteractionMode',
] as const satisfies readonly (keyof CommandFlags)[];

type LeaseAllocateProviderFlagKey = (typeof LEASE_ALLOCATE_PROVIDER_FLAG_KEYS)[number];

/**
 * The device-spec keys a lease request can name beside platform, target and device. They ride
 * `lease_allocate` like the keys above, but only a backend in front of the daemon honours them: a
 * daemon refuses every request that names one, so no request is served on a device that ignored
 * part of what it asked for.
 */
export const LEASE_DEVICE_SPEC_KEYS = [
  'osVersion',
  'imageTag',
  'physical',
] as const satisfies readonly (keyof CommandFlags & keyof LeaseDeviceSpec)[];

type LeaseDeviceSpecKey = (typeof LEASE_DEVICE_SPEC_KEYS)[number];

/** The typed reason a request naming a device spec is refused with. */
const DEVICE_SPEC_UNSUPPORTED_REASON = 'device-spec-unsupported';

/** The typed reason a request giving a device-spec key a value of the wrong type is refused with. */
const DEVICE_SPEC_INVALID_REASON = 'device-spec-invalid';

// A Cloud provider profile field added without joining the projection would be dropped from the
// envelope and fail `prepareSession` on the remote daemon — this makes that omission fail to build.
type LeaseAllocateProfileKeysAreExhaustive =
  Exclude<keyof CloudProviderProfileFields, LeaseAllocateProviderFlagKey> extends never
    ? true
    : Exclude<keyof CloudProviderProfileFields, LeaseAllocateProviderFlagKey>;
const leaseAllocateProfileKeysExhaustive: LeaseAllocateProfileKeysAreExhaustive = true;
void leaseAllocateProfileKeysExhaustive;

type LeaseAllocateProviderFlags = Partial<
  Pick<CommandFlags, LeaseAllocateProviderFlagKey | LeaseDeviceSpecKey>
>;

/**
 * Reads the allocation flags out of a request flags bag or a lease-envelope param bag. A named or
 * invalid device-spec key is carried as given, so the daemon refuses an invalid one instead of never
 * seeing it; a key that names nothing is dropped.
 */
export function readLeaseAllocateProviderFlags(
  source: Record<string, unknown> | undefined,
): LeaseAllocateProviderFlags {
  const flags: Record<string, unknown> = {};
  for (const key of LEASE_ALLOCATE_PROVIDER_FLAG_KEYS) {
    const value = source?.[key];
    if (typeof value === 'string' || typeof value === 'boolean') flags[key] = value;
  }
  const { spec, invalidKeys } = readLeaseDeviceSpec(source);
  Object.assign(flags, spec);
  for (const key of invalidKeys) flags[key] = source?.[key];
  return flags as LeaseAllocateProviderFlags;
}

export type LeaseDeviceSpecReading = {
  /** The keys the source names, with their values as given. */
  spec: LeaseDeviceSpec;
  /** The keys of `spec`, in `LEASE_DEVICE_SPEC_KEYS` order. */
  keys: LeaseDeviceSpecKey[];
  /** The keys whose value has the wrong type for a spec. */
  invalidKeys: LeaseDeviceSpecKey[];
};

/**
 * The one decision on what a device spec names, for the CLI, the SDK, MCP and the daemon alike.
 * Each key is named, not named, or invalid: a non-blank `osVersion` or `imageTag` and
 * `physical: true` are named, with the value as given; an absent key, a blank string and
 * `physical: false` name nothing; any other type is invalid.
 */
export function readLeaseDeviceSpec(
  source: { osVersion?: unknown; imageTag?: unknown; physical?: unknown } | undefined,
): LeaseDeviceSpecReading {
  const spec: Record<string, string | boolean> = {};
  const invalidKeys: LeaseDeviceSpecKey[] = [];
  for (const key of LEASE_DEVICE_SPEC_KEYS) {
    const value = source?.[key];
    if (value === undefined) continue;
    if (typeof value !== (key === 'physical' ? 'boolean' : 'string')) invalidKeys.push(key);
    else if (value === true) spec[key] = true;
    else if (typeof value === 'string' && value.trim()) spec[key] = value;
  }
  const keys = LEASE_DEVICE_SPEC_KEYS.filter((key) => key in spec);
  return { spec: spec as LeaseDeviceSpec, keys, invalidKeys };
}

/** The named spec of a client-side source, which refuses an invalid key before any request. */
export function requireLeaseDeviceSpec(
  source: Parameters<typeof readLeaseDeviceSpec>[0],
): Pick<LeaseDeviceSpecReading, 'spec' | 'keys'> {
  const { spec, keys, invalidKeys } = readLeaseDeviceSpec(source);
  if (invalidKeys.length > 0) throw deviceSpecInvalidError(invalidKeys);
  return { spec, keys };
}

/** The granted device facts on a lease reply, or `undefined` when the reply carries none. */
export function readLeaseDevice(value: unknown): LeaseDevice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const model = nonEmptyString(record.model);
  const osVersion = nonEmptyString(record.osVersion);
  if (!model || !osVersion || typeof record.physical !== 'boolean') return undefined;
  const imageTag = nonEmptyString(record.imageTag);
  return {
    model,
    osVersion,
    ...(imageTag ? { imageTag } : {}),
    physical: record.physical,
  };
}

/** The refusal for a request whose device spec nothing on its path can honour. */
export function deviceSpecUnsupportedError(
  keys: readonly string[],
  message = 'This daemon cannot pick a device by OS version, image tag, or physical/virtual class.',
  details: Record<string, unknown> = {},
): AppError {
  return new AppError('UNSUPPORTED_OPERATION', message, {
    ...details,
    reason: DEVICE_SPEC_UNSUPPORTED_REASON,
    keys: [...keys],
    hint: 'Drop --os, --image-tag and --physical, or connect through a proxy whose backend picks devices by spec.',
  });
}

/** The refusal for a request giving a device-spec key a value of the wrong type. */
export function deviceSpecInvalidError(keys: readonly string[]): AppError {
  return new AppError(
    'INVALID_ARGS',
    'osVersion and imageTag take a string, and physical takes a boolean.',
    { reason: DEVICE_SPEC_INVALID_REASON, keys: [...keys] },
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function leaseScopeToConnectionMetadata(
  scope: LeaseScope,
): Pick<LeaseScope, 'leaseProvider' | 'deviceKey' | 'clientId'> | undefined {
  const connection = stripUndefined({
    leaseProvider: scope.leaseProvider,
    deviceKey: scope.deviceKey,
    clientId: scope.clientId,
  });
  return Object.keys(connection).length > 0 ? connection : undefined;
}

/**
 * @internal Lease diagnostics seam exposed for unit tests.
 */
export function buildLeaseDiagnosticsContext(
  leaseScope: LeaseScope | undefined,
): LeaseDiagnosticsContext | undefined {
  if (!leaseScope) return undefined;
  const context = stripUndefined({
    tenantId: leaseScope.tenantId,
    runId: leaseScope.runId,
    leaseId: leaseScope.leaseId,
    leaseBackend: leaseScope.leaseBackend,
    leaseProvider: leaseScope.leaseProvider,
    deviceKey: leaseScope.deviceKey,
    clientId: leaseScope.clientId,
  });
  return Object.keys(context).length > 0 ? context : undefined;
}

/** The `deviceKey` a proxy lease binds a device under: its public platform, target, and id. */
export function leaseDeviceKey(device: { platform: string; target?: string; id: string }): string {
  return `${device.platform}:${device.target ?? 'mobile'}:${device.id}`;
}

/**
 * The raw fields a {@link leaseDeviceKey} key was written from, or `undefined` for a malformed key.
 * The id is everything after the second `:`, so an id may itself contain `:`.
 */
export function parseLeaseDeviceKey(
  key: string | undefined,
): { platform: string; target: string; id: string } | undefined {
  const match = /^([^:]+):([^:]+):(.+)$/.exec(key ?? '');
  if (!match) return undefined;
  const [, platform, target, id] = match;
  return { platform: platform!, target: target!, id: id! };
}

export function isProxyLeaseScope(scope: LeaseScope): boolean {
  return scope.leaseProvider === PROXY_LEASE_PROVIDER;
}

/**
 * The provider whose registered runtime must back this lease, or `undefined` for a logical lease:
 * one with no provider (a `leaseBackend` alone names no provider), `proxy`, or `cloud`.
 */
export function leaseProviderRequiringRuntime(scope: LeaseScope): string | undefined {
  const { leaseProvider } = scope;
  return leaseProvider === undefined || RUNTIME_LESS_LEASE_PROVIDERS.has(leaseProvider)
    ? undefined
    : leaseProvider;
}

export function findMissingProxyLeaseFields(scope: LeaseScope): string[] {
  if (!isProxyLeaseScope(scope)) return [];
  return REQUIRED_PROXY_LEASE_FIELDS.filter((field) => !scope[field]);
}

/**
 * The shortest inactivity window a lease can hold by default.
 *
 * The registry clamps every ttl to this floor, so it is also the worst case a client plans against
 * before it has seen a lease answer: work that has to finish inside a lease window it does not know
 * yet must assume this one, or it can be planning for a window the daemon would never grant.
 */
export const MIN_LEASE_WINDOW_MS = 5_000;

/**
 * Why a lease stopped being ours: it is gone, spent, or taken back.
 *
 * This is the whole taxonomy of "the lease is no longer usable" as the daemon reports it, and both
 * readers ask the same question — a client deciding whether a connection still owns a device, and a
 * lease beat deciding whether an upload is still worth finishing. A reason naming a mismatch between
 * a request and a lease is not in here: that says something about the request, not the lease.
 */
const INACTIVE_LEASE_REASONS: ReadonlySet<unknown> = new Set([
  'LEASE_NOT_FOUND',
  'LEASE_EXPIRED',
  'LEASE_REVOKED',
]);

/** Whether `error` says the lease is gone rather than merely unavailable to this request. */
export function isInactiveLeaseError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Readonly<{ code?: unknown }>).code === 'UNAUTHORIZED' &&
    INACTIVE_LEASE_REASONS.has(
      (error as Readonly<{ details?: Readonly<{ reason?: unknown }> }>).details?.reason,
    )
  );
}

/** The leases a daemon reply says its request ended; a malformed entry is no ended lease. */
export function readEndedLeases(response: DaemonResponse): EndedLease[] {
  const body = response.ok ? response.data : response.error.details;
  const entries = body?.endedLeases;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { leaseId, outcome } = entry as Readonly<{ leaseId?: unknown; outcome?: unknown }>;
    return typeof leaseId === 'string' && outcome === 'released' ? [{ leaseId, outcome }] : [];
  });
}

function leaseScopeToScopedRequest(scope: LeaseScope): LeaseScopedRequestScope {
  return stripUndefined({
    leaseId: scope.leaseId ?? '',
    tenantId: scope.tenantId,
    runId: scope.runId,
    leaseBackend: scope.leaseBackend,
    leaseProvider: scope.leaseProvider,
    deviceKey: scope.deviceKey,
    clientId: scope.clientId,
    ttlMs: scope.leaseTtlMs,
  }) as LeaseScopedRequestScope;
}

function readFlagString(
  flags: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = flags?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The JSON-RPC envelope a client puts on the daemon's `/rpc` endpoint for one request: the command
 * method for an ordinary request, and the lease method with its lease params for a lease command.
 * The caller supplies the request id, so the envelope is the same for every client.
 * Provider values are forwarded verbatim; lease-provider normalization belongs to the daemon.
 */
export function buildDaemonRpcRequest(
  req: DaemonWireRequest,
  options: { id: string; includeTokenParam: boolean },
): {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: DaemonWireRequest | Record<string, unknown>;
} {
  const { id } = options;
  if (!isLeaseRpcCommand(req.command)) {
    return {
      jsonrpc: '2.0',
      id,
      method: 'agent_device.command',
      params: req,
    };
  }
  return {
    jsonrpc: '2.0',
    id,
    method: leaseRpcMethodForCommand(req.command),
    params: {
      ...buildLeaseRpcParams(req, req.command, options),
      ...(req.command === 'lease_allocate' ? readLeaseAllocateProviderFlags(req.flags) : {}),
      ...(req.command === 'lease_allocate' && req.meta?.providerCredentialFingerprint
        ? { providerCredentialFingerprint: req.meta.providerCredentialFingerprint }
        : {}),
    },
  };
}

function isLeaseRpcCommand(command: string): command is LeaseRpcCommand {
  return (
    command === 'lease_allocate' || command === 'lease_heartbeat' || command === 'lease_release'
  );
}

function leaseRpcMethodForCommand(command: LeaseRpcCommand): string {
  switch (command) {
    case 'lease_allocate':
      return 'agent_device.lease.allocate';
    case 'lease_heartbeat':
      return 'agent_device.lease.heartbeat';
    case 'lease_release':
      return 'agent_device.lease.release';
  }
}

function buildLeaseRpcParams(
  req: DaemonWireRequest,
  command: LeaseRpcCommand,
  options: { includeTokenParam: boolean },
): Record<string, unknown> {
  return leaseScopeToLeaseRpcParams(leaseScopeFromRequest(req), command, {
    includeTokenParam: options.includeTokenParam,
    token: req.token,
    session: req.session,
  });
}
