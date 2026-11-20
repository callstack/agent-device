import type { RegisteredPlatformSetup } from './platform.ts';
import { isPlatform, type Platform } from '@agent-device/kernel/device-identity';
import { NATIVE_REPLAY_BACKEND } from '@agent-device/contracts/replay-execution';
import type { WebPlatformOperations } from '@agent-device/contracts/platform-plugin';
import type { ReplayExecution } from '@agent-device/contracts/replay-execution';
import type { ReplayBackend } from '@agent-device/contracts/replay-backend';
import type { ReplayBackendSetup, ReplayExecutionSetup } from './replay-backend.ts';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import { PLUGIN_API_VERSION, ROUTING_PROVIDER_IDENTITIES, type Contribution } from './contract.ts';

const ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]*$/;

/** The id shape every claim space admits: a lowercase label such as `browserstack` or `maestro`. */
const CLAIM_ID = /^[a-z][a-z0-9-]*$/;

/** The claim space one contribution kind owns. */
export type ClaimKind = 'provider' | 'platform' | 'replay-backend' | 'replay-execution';

/** One claim: its kind's space and the id this plugin holds in it. */
export type PluggedClaim = Readonly<{ kind: ClaimKind; id: string }>;

/** How a claim's space names it in the inventory and in a cleanup outcome. */
export type ClaimIdentity = Readonly<
  { provider: string } | { backend: string } | { platform: string }
>;

/** Deterministic order for reading a package's static claims and for claim spaces. */
const CLAIM_KINDS: Readonly<Record<ClaimKind, ClaimKindSpec>> = {
  provider: {
    metadataField: 'provider',
    contributionIdField: 'provider',
    reservedError: (id) =>
      ROUTING_PROVIDER_IDENTITIES.includes(id)
        ? new AppError('INVALID_ARGS', `Provider id is reserved for routing: ${id}`, {
            reason: 'reserved_provider',
            provider: id,
          })
        : undefined,
    duplicateReason: 'duplicate_provider',
    identityFor: (id) => ({ provider: id }),
    readMetadata: (value) => readableClaimId(value, 'provider'),
    readContribution: (value) => ({ kind: 'provider', id: readProviderContribution(value) }),
    validateSetup: () => {},
  },
  platform: {
    metadataField: 'platform',
    contributionIdField: 'family',
    reservedError: (id) =>
      isPlatform(id) ? undefined : invalidPlugin(`Unknown platform family: ${id}`),
    duplicateReason: 'duplicate_platform',
    identityFor: (id) => ({ platform: id }),
    readMetadata: (value) => readableClaimId(value, 'platform'),
    readContribution: (value) => {
      const id = readableClaimId(value.family, 'family');
      if (typeof value.setup !== 'function') {
        throw invalidPlugin('A platform contribution must provide setup(host)');
      }
      return { kind: 'platform', id };
    },
    validateSetup: validatePlatformSetup,
  },
  'replay-backend': {
    metadataField: 'replayBackend',
    contributionIdField: 'backend',
    reservedError: (id) =>
      id === NATIVE_REPLAY_BACKEND
        ? new AppError(
            'INVALID_ARGS',
            `Replay backend id is reserved for native execution: ${id}`,
            {
              reason: 'reserved_replay_backend',
              backend: id,
            },
          )
        : undefined,
    duplicateReason: 'duplicate_replay_backend',
    identityFor: (id) => ({ backend: id }),
    readMetadata: (value) => readableClaimId(value, 'replayBackend'),
    readContribution: (value) => {
      if (!isClaimId(value.backend)) {
        throw invalidPlugin('A replay-backend contribution must declare a backend id');
      }
      if (typeof value.setup !== 'function') {
        throw invalidPlugin('A replay-backend contribution must provide setup(host)');
      }
      return { kind: 'replay-backend', id: value.backend };
    },
    validateSetup: (value) => {
      validateReplayBackendSetup(value);
    },
  },
  'replay-execution': {
    metadataField: 'replayExecution',
    contributionIdField: 'id',
    duplicateReason: 'duplicate_replay_execution',
    identityFor: (id) => ({ backend: id }),
    readMetadata: (value) => {
      // One spelling for this claim: the id itself belongs to the kind, not to the package.
      if (value !== true) throw invalidPlugin('Plugin metadata replayExecution must be true');
      return NATIVE_REPLAY_BACKEND;
    },
    readContribution: (value) => {
      if (value.id !== NATIVE_REPLAY_BACKEND) {
        throw invalidPlugin(
          `A replay-execution contribution must declare id ${NATIVE_REPLAY_BACKEND}`,
        );
      }
      if (typeof value.setup !== 'function') {
        throw invalidPlugin('A replay-execution contribution must provide setup(host)');
      }
      return { kind: 'replay-execution', id: NATIVE_REPLAY_BACKEND };
    },
    validateSetup: (value) => {
      validateReplayExecutionSetup(value);
    },
  },
} satisfies Readonly<Record<ClaimKind, ClaimKindSpec>>;

/**
 * One claim kind's whole contract: the metadata field that spells its id, how each source reads that
 * id, what its space reserves, what a lost duplicate race reports, and the setup shape it answers.
 * A new kind is one entry here plus its contribution type.
 */
type ClaimKindSpec = Readonly<{
  /** The `agent-device` package.json field that spells this kind's id. */
  metadataField: string;
  /** The contribution field that spells this kind's id. */
  contributionIdField: string;
  /** Ids no plugin may claim in this space. */
  reservedError?(id: string): AppError | undefined;
  /** What a claim that loses this space's duplicate race reports. */
  duplicateReason: string;
  /** How this space names the claim in the inventory and in cleanup outcomes. */
  identityFor(id: string): ClaimIdentity;
  /** Reads the id out of the `agent-device` field. */
  readMetadata(value: unknown): string;
  /** Validates one contribution of this kind and answers its claim. */
  readContribution(value: Record<string, unknown>): PluggedClaim;
  /** Checks what setup returned before the registry keeps the claim. */
  validateSetup(value: unknown, id: string): void;
}>;

/** The claim spaces, in the order a package's static claims are read and compared. */
const CLAIM_KIND_ORDER = Object.keys(CLAIM_KINDS) as readonly ClaimKind[];

/**
 * The one validation of what a plugin factory returned, whichever source produced it: the whole
 * declaration is validated before any of its claims is published.
 */
export function validateAgentDevicePlugin(
  value: unknown,
): readonly (PluggedClaim & { contribution: Contribution })[] {
  if (!isRecord(value)) throw invalidPlugin('Plugin factory must return a plugin object');
  if (value.apiVersion !== PLUGIN_API_VERSION) throw incompatiblePluginApi(value.apiVersion);
  if (!Array.isArray(value.contributes) || value.contributes.length === 0) {
    throw invalidPlugin('Plugin must declare a nonempty contributes list');
  }
  const keys = new Set<string>();
  const claims = [];
  for (const contribution of value.contributes as readonly unknown[]) {
    const claim = claimOfContribution(contribution);
    assertClaimAvailable(claim);
    const key = claimKeyOf(claim);
    if (keys.has(key)) {
      throw invalidPlugin(`Plugin declares the same claim twice: ${key}`);
    }
    keys.add(key);
    claims.push({ ...claim, contribution: contribution as Contribution });
  }
  return claims;
}

/** The claim a contribution names, after validating the contribution's own shape. */
function claimOfContribution(value: unknown): PluggedClaim {
  if (!isRecord(value)) throw invalidPlugin('Each contribution must be an object');
  const spec = claimKindSpecOf(value.kind);
  if (spec === undefined) throw invalidPlugin(`Unknown contribution kind: ${String(value.kind)}`);
  return spec.readContribution(value);
}

/** One claim as the store's declared claims and the registry compare them: `kind:id`. */
export function claimKeyOf(claim: PluggedClaim): string {
  return `${claim.kind}:${claim.id}`;
}

/** Why a claim cannot be held at all: a reserved id belongs to the host, not to a package. */
export function reservedClaimError(claim: PluggedClaim): AppError | undefined {
  return CLAIM_KINDS[claim.kind].reservedError?.(claim.id);
}

/** Whether anything may still claim this id: a reserved id belongs to the host, not to a package. */
function assertClaimAvailable(claim: PluggedClaim): void {
  const reserved = reservedClaimError(claim);
  if (reserved !== undefined) throw reserved;
}

/**
 * The claims a returned value already names, read through the same table without validating it. Only
 * a slot that failed before its claims were readable uses this, so the inventory and the plugin that
 * selected it can still say what it was meant to provide.
 */
export function readableClaimsOfValue(value: unknown): readonly PluggedClaim[] {
  if (!isRecord(value)) return [];
  const claims: PluggedClaim[] = [...versionTwoReplayClaims(value)];
  for (const kind of CLAIM_KIND_ORDER) {
    const spec = CLAIM_KINDS[kind];
    const declared = claimIdSpelledBy(kind, value[spec.metadataField]);
    if (declared !== undefined) {
      claims.push({ kind, id: declared });
      continue;
    }
    if (!Array.isArray(value.contributes)) continue;
    for (const contribution of value.contributes) {
      if (!isRecord(contribution) || contribution.kind !== kind) continue;
      const named = claimIdSpelledBy(kind, contribution[spec.contributionIdField]);
      if (named !== undefined) claims.push({ kind, id: named });
    }
  }
  return claims;
}

/**
 * The version 2 replay shape, `{ kind: 'replay-backend', backend }` at the top level, which the host
 * refuses. Its reserved id `ad` named native execution, so a refused candidate still names its claim.
 */
function versionTwoReplayClaims(value: Record<string, unknown>): readonly PluggedClaim[] {
  if (value.kind !== 'replay-backend' || !isClaimId(value.backend)) return [];
  return [
    value.backend === NATIVE_REPLAY_BACKEND
      ? { kind: 'replay-execution', id: NATIVE_REPLAY_BACKEND }
      : { kind: 'replay-backend', id: value.backend },
  ];
}

/** The id this value spells for a kind, or nothing when it does not spell one. */
function claimIdSpelledBy(kind: ClaimKind, value: unknown): string | undefined {
  // The native claim's id belongs to the kind, so its metadata spells it as `true`.
  if (kind === 'replay-execution' && value === true) {
    return NATIVE_REPLAY_BACKEND;
  }
  return isClaimId(value) ? value : undefined;
}

/** What the registry records when a later candidate loses this claim to the first one. */
export function duplicateClaimError(claim: PluggedClaim): AppError {
  const spec = CLAIM_KINDS[claim.kind];
  return new AppError('INVALID_ARGS', `Duplicate ${claim.kind} claim: ${claim.id}`, {
    reason: spec.duplicateReason,
    ...spec.identityFor(claim.id),
  });
}

/** How a claim's space names it: `provider` or `backend`. */
export function identityOfClaim(claim: PluggedClaim): ClaimIdentity {
  return CLAIM_KINDS[claim.kind].identityFor(claim.id);
}

/** Checks a setup result against the kind that asked for it. */
export function validateClaimSetup(
  claim: PluggedClaim & { kind: 'platform' },
  value: unknown,
): asserts value is RegisteredPlatformSetup;
export function validateClaimSetup(claim: PluggedClaim, value: unknown): void;
export function validateClaimSetup(claim: PluggedClaim, value: unknown): void {
  CLAIM_KINDS[claim.kind].validateSetup(value, claim.id);
}

/**
 * The claims a plugin package's `agent-device` metadata declares, in kind order: the contract version
 * plus each static claim id, read through its own kind. Read before any import; after the factory
 * runs, its returned claims must equal these, in any order.
 */
export function readPluginPackageClaims(field: unknown): readonly PluggedClaim[] {
  if (!isRecord(field) || field.apiVersion !== PLUGIN_API_VERSION) {
    throw incompatiblePackageApi(field);
  }
  const claims: PluggedClaim[] = [];
  for (const kind of CLAIM_KIND_ORDER) {
    const spec = CLAIM_KINDS[kind];
    const declared = field[spec.metadataField];
    if (declared === undefined) continue;
    const id = spec.readMetadata(declared);
    assertClaimAvailable({ kind, id });
    claims.push({ kind, id });
  }
  return claims;
}

function validatePlatformSetup(value: unknown, family: string): void {
  if (
    !isRecord(value) ||
    value.family !== family ||
    !isRecord(value.inventoryModule) ||
    value.inventoryModule.family !== family ||
    typeof value.inventoryModule.loadInventory !== 'function' ||
    !isRecord(value.runtimeModule) ||
    value.runtimeModule.family !== family ||
    typeof value.runtimeModule.loadRuntime !== 'function' ||
    typeof value.createInteractor !== 'function'
  ) {
    throw invalidPlugin(`Platform setup must supply matching family modules: ${family}`);
  }
  if (isPlatform(family)) PLATFORM_SETUP_CHECKS[family]?.(value);
}

const WEB_OPERATIONS: Record<keyof WebPlatformOperations, true> = {
  setup: true,
  doctor: true,
  cleanupOrphans: true,
  browserLifecycleCheck: true,
  createProvider: true,
  resolveRequestProvider: true,
};

const PLATFORM_SETUP_CHECKS: Partial<Record<Platform, (value: Record<string, unknown>) => void>> = {
  web(value) {
    const operations = value.operations;
    if (
      typeof value.withRequestProvider !== 'function' ||
      !isRecord(operations) ||
      Object.keys(WEB_OPERATIONS).some((operation) => typeof operations[operation] !== 'function')
    ) {
      throw invalidPlugin('Web platform setup must supply request scoping and web operations');
    }
  },
};

function isClaimId(value: unknown): value is string {
  return typeof value === 'string' && CLAIM_ID.test(value);
}

function claimKindSpecOf(kind: unknown): ClaimKindSpec | undefined {
  return CLAIM_KIND_ORDER.includes(kind as ClaimKind) ? CLAIM_KINDS[kind as ClaimKind] : undefined;
}

function readableClaimId(value: unknown, field: string): string {
  if (!isClaimId(value)) {
    throw new AppError('INVALID_ARGS', `Plugin metadata ${field} must be a lowercase id`, {
      reason: 'invalid_plugin',
    });
  }
  return value;
}

/**
 * A plugin object on another contract version gets the typed incompatibility, without a shim.
 */
function incompatiblePluginApi(declared: unknown): AppError {
  return new AppError('INVALID_ARGS', 'Plugin does not declare a compatible contract version', {
    reason: 'incompatible-plugin-api',
    apiVersion: PLUGIN_API_VERSION,
    ...(declared !== undefined ? { declaredApiVersion: declared } : {}),
    hint: incompatibleApiHint('plugin', declared),
  });
}

/**
 * A package whose `agent-device` field is missing, or names another version, gets the same reason.
 */
function incompatiblePackageApi(field: unknown): AppError {
  const declared = isRecord(field) ? field.apiVersion : undefined;
  return new AppError(
    'INVALID_ARGS',
    'Plugin package does not declare a compatible contract version',
    {
      reason: 'incompatible-plugin-api',
      apiVersion: PLUGIN_API_VERSION,
      ...(declared !== undefined ? { declaredApiVersion: declared } : {}),
      hint: incompatibleApiHint('package', declared),
    },
  );
}

/**
 * The hint names what this host saw, so the author of a version 3 package that lost its
 * `agent-device` field is told to add the field rather than to look for another release.
 */
function incompatibleApiHint(source: 'plugin' | 'package', declared: unknown): string {
  const seen =
    declared !== undefined
      ? `declares apiVersion ${String(declared)}, which this host does not support`
      : source === 'package'
        ? 'has no "agent-device" package.json field with an apiVersion'
        : 'returns no apiVersion';
  const named = source === 'package' ? 'The plugin package' : 'The plugin';
  return (
    `${named} ${seen}. This host speaks plugin contract apiVersion ${PLUGIN_API_VERSION} with no` +
    ` compatibility shim: install a release built for apiVersion ${PLUGIN_API_VERSION}, or add the` +
    ` "agent-device" field with "apiVersion": ${PLUGIN_API_VERSION} and the package's claim ids.`
  );
}

function readProviderContribution(value: Record<string, unknown>): string {
  if (!isClaimId(value.provider)) {
    throw invalidPlugin('Plugin provider must be a lowercase id such as "example"');
  }
  const provider = value.provider;
  assertCredentials(value.credentials);
  if (value.connection !== undefined) assertConnection(value.connection);
  if (typeof value.setup !== 'function') throw invalidPlugin('Plugin must provide setup(host)');
  return provider;
}

function assertCredentials(credentials: unknown): void {
  if (!isRecord(credentials) || !Array.isArray(credentials.variables)) {
    throw invalidPlugin('Plugin credentials must declare variables');
  }
  assertCredentialVariables(credentials.variables);
  if (credentials.byBackend === undefined) return;
  if (!isRecord(credentials.byBackend)) {
    throw invalidPlugin('Plugin credentials byBackend must map a lease backend to variables');
  }
  for (const names of Object.values(credentials.byBackend)) {
    if (!Array.isArray(names)) {
      throw invalidPlugin('Plugin credentials byBackend must map a lease backend to variables');
    }
    assertCredentialVariables(names);
  }
}

function assertCredentialVariables(variables: unknown): void {
  if (
    !Array.isArray(variables) ||
    !variables.every((name) => typeof name === 'string' && ENVIRONMENT_VARIABLE.test(name))
  ) {
    throw invalidPlugin('Plugin credential variables must list environment variable names');
  }
}

function assertConnection(connection: unknown): void {
  if (
    !isRecord(connection) ||
    connection.capabilities === undefined ||
    typeof connection.resolve !== 'function' ||
    typeof connection.verify !== 'function'
  ) {
    throw invalidPlugin('Plugin connection must provide capabilities, resolve and verify');
  }
  assertLocalConnectionCapabilities(connection.capabilities as ConnectionProviderCapabilities);
}

function assertLocalConnectionCapabilities(
  policy: ConnectionProviderCapabilities | undefined,
): void {
  if (policy === undefined) return;
  if (
    !policy ||
    typeof policy !== 'object' ||
    policy.leaseKind !== 'direct-device-provider' ||
    [
      'requiresAppAttachment',
      'requiresRemoteDaemon',
      'supportsArtifacts',
      'supportsDeferredAppSelection',
      'supportsDirectPortReverse',
      'usesCloudWebDriverLease',
    ].some((key) => typeof policy[key as keyof ConnectionProviderCapabilities] !== 'boolean') ||
    (policy.holdsCloudDevice !== undefined && typeof policy.holdsCloudDevice !== 'boolean') ||
    (policy.forgetsEndedConnectionLease !== undefined &&
      typeof policy.forgetsEndedConnectionLease !== 'boolean') ||
    policy.requiresRemoteDaemon
  ) {
    throw invalidPlugin('Plugin connection must declare local provider capabilities');
  }
}

/** The runtime a plugin built must answer to the provider id it registered. */
export function assertProviderRuntime(
  provider: string,
  runtime: ProviderDeviceRuntime | undefined,
  platformModule: PlatformRuntimeProviderModule | undefined,
): void {
  const owner = platformModule?.owner;
  if (
    runtime?.provider !== provider ||
    typeof runtime.shutdown !== 'function' ||
    !hasProviderFacets(runtime) ||
    owner?.kind !== 'provider-runtime' ||
    owner.provider !== provider ||
    typeof owner.instance !== 'string' ||
    owner.instance.trim().length === 0 ||
    typeof platformModule?.loadRuntime !== 'function'
  ) {
    throw invalidPlugin(`Plugin runtime owner does not match its provider: ${provider}`);
  }
}

function hasProviderFacets(runtime: ProviderDeviceRuntime): boolean {
  return (
    runtime.leaseLifecycle !== null &&
    typeof runtime.leaseLifecycle === 'object' &&
    (['ownsDevice', 'getInteractor', 'deviceInventoryProvider'] as const).every(
      (method) => typeof runtime[method] === 'function',
    )
  );
}

export function invalidPlugin(message: string): AppError {
  return new AppError('INVALID_ARGS', message, { reason: 'invalid_plugin' });
}

/** A format backend's setup must provide the lazy backend factory and nothing else. */
export function validateReplayBackendSetup(value: unknown): ReplayBackendSetup {
  if (
    !isRecord(value) ||
    (value.dispose !== undefined && typeof value.dispose !== 'function') ||
    value.execution !== undefined ||
    !isRecord(value.replayBackend) ||
    typeof value.replayBackend.create !== 'function'
  ) {
    throw invalidPlugin('Format backend setup must provide replayBackend.create(host)');
  }
  return value as ReplayBackendSetup;
}

/** Native execution's setup must provide the lazy execution factory and nothing else. */
export function validateReplayExecutionSetup(value: unknown): ReplayExecutionSetup {
  if (
    !isRecord(value) ||
    (value.dispose !== undefined && typeof value.dispose !== 'function') ||
    value.replayBackend !== undefined ||
    !isRecord(value.execution) ||
    typeof value.execution.create !== 'function'
  ) {
    throw invalidPlugin('Native ad execution setup must provide execution.create()');
  }
  return value as ReplayExecutionSetup;
}

export function validateReplayExecution(value: unknown): ReplayExecution {
  if (
    !isRecord(value) ||
    (['inspectAdReplay', 'runAdReplay', 'runReplayTestSuite'] as const).some(
      (name) => typeof value[name] !== 'function',
    )
  ) {
    throw invalidPlugin(
      'Native replay execution must provide inspection, replay and suite execution',
    );
  }
  return value as ReplayExecution;
}

export function validateReplayBackend(id: string, value: unknown): ReplayBackend {
  if (
    !isRecord(value) ||
    value.id !== id ||
    (['collectSourceFiles', 'inspectSource', 'runReplay', 'exportReplayScript'] as const).some(
      (name) => typeof value[name] !== 'function',
    )
  ) {
    throw invalidPlugin(`Replay plugin runtime does not match its backend: ${id}`);
  }
  return value as ReplayBackend;
}
