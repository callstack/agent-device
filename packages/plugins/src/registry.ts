import type { OptionalPlatform } from '@agent-device/contracts/platform-module';
import type { PlatformHost, RegisteredPlatformSetup } from './platform.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type {
  ReplayExecution,
  ReplayExecutionResolver,
} from '@agent-device/contracts/replay-execution';
import type { ReplayBackend } from '@agent-device/contracts/replay-backend';
import type {
  ReplayBackendResolver,
  ReplayBackendSetup,
  ReplayExecutionSetup,
} from './replay-backend.ts';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import type {
  Contribution,
  PluginConnection,
  PluginSetupResult,
  PluginWebDriverSetup,
  ProviderContribution,
  WebDriverDescriptor,
} from './contract.ts';
import type { RegisteredConnection } from './connection.ts';
import { createPluginHost, createReplaySetupHost } from './host.ts';
import {
  NO_PLUGIN_CREDENTIALS,
  type PluginCleanupOutcome,
  type PluginCleanupStep,
  type PluginInventoryEntry,
  type PluginSource,
} from '@agent-device/contracts/plugin-inventory';
import { describePluginFailure } from './inventory.ts';
import {
  assertProviderRuntime,
  claimKeyOf,
  duplicateClaimError,
  identityOfClaim,
  invalidPlugin,
  readableClaimsOfValue,
  reservedClaimError,
  validateAgentDevicePlugin,
  validateClaimSetup,
  validateReplayBackend,
  validateReplayExecution,
  type ClaimKind,
  type PluggedClaim,
} from './validate.ts';

/**
 * One plugin a source offers the registry. Sources differ only in how a candidate loads; the
 * registry validates, claims and sets up every candidate the same way.
 */
export type PluginCandidate = Readonly<{
  source: PluginSource;
  package?: string;
  version?: string;
  selectionStamp?: string;
  /** Holds its declared claims without registering or listing them: a built-in that is not configured. */
  dormant?: boolean;
  /** The `options` the store passes to the host when it calls the factory. */
  hostOptions?: Record<string, unknown>;
  /**
   * The claims the package's `agent-device` metadata declares, validated before import. The registry
   * reserves them as soon as it reaches this candidate, so a slot that then fails to load keeps them,
   * and once the factory runs its returned claims must equal these, in any order.
   */
  declaredClaims?: readonly PluggedClaim[];
  /** Returns the unvalidated plugin, or throws the reason it cannot load. */
  load(): Promise<unknown> | unknown;
}>;

/** Holds provider ids without loading anything, as the built-in sources do for their own. */
export function claimProviderIds(providers: readonly string[]): PluginCandidate[] {
  return providers.map((provider) => ({
    source: 'builtin',
    dormant: true,
    declaredClaims: [{ kind: 'provider', id: provider }],
    load: () => undefined,
  }));
}

/**
 * What the composing root decides for every registry, so this package names no provider: how a
 * plugin's `{ webDriver }` descriptor becomes a runtime.
 */
export type PluginRegistryPolicy = Readonly<{
  platformHost?: PlatformHost;
  assertSelectionCurrent?(packageName: string): void;
  adaptWebDriver(
    descriptor: WebDriverDescriptor,
    context: Readonly<{ clientVersion: string }>,
  ): Promise<Pick<ProviderRegistration, 'runtime' | 'platformModule'>>;
}>;

export type ProviderRegistration = Readonly<{
  provider: string;
  source: PluginSource;
  runtime: ProviderDeviceRuntime;
  platformModule: PlatformRuntimeProviderModule;
  /** The plugin's own cleanup, run once by {@link ProviderRegistry.close} after the runtime shuts down. */
  dispose?: () => Promise<void> | void;
}>;

/** Every id held in one claim space. */
type ClaimedClaims = Map<ClaimKind, Set<string>>;

/**
 * One contribution expanded into its own claim: its own record, setup outcome and cleanup entry. A
 * claim reserved before the load settles carries no contribution until the factory answers it.
 */
type Claim = PluggedClaim & {
  slot: Slot;
  contribution?: Contribution;
  failure?: unknown;
  registration?: ProviderRegistration;
  platformSetup?: RegisteredPlatformSetup;
  replaySetup?: ReplayBackendSetup | ReplayExecutionSetup;
  replayLoading?: Promise<ReplayBackend>;
  executionLoading?: Promise<ReplayExecution>;
  replayFailure?: unknown;
};

/** A candidate, its load outcome, and the claims it holds. */
type Slot = {
  candidate: PluginCandidate;
  /** Why this slot cannot answer its claims; each unclaimed entry reports it. */
  failure?: unknown;
  claims: Claim[];
};

/** A claim as the composition reads it: its kind, id, contribution and owning candidate. */
export type ResolvedClaim = Readonly<{
  kind: ClaimKind;
  id: string;
  candidate: PluginCandidate;
  contribution?: Contribution;
}>;

/** What a root reads from the slots it does not own: each claim with its contribution and candidate. */
function claimsOf(slots: readonly Slot[]): readonly ResolvedClaim[] {
  return slots.flatMap(({ claims }) =>
    claims.map((claim) =>
      Object.freeze({
        kind: claim.kind,
        id: claim.id,
        candidate: claim.slot.candidate,
        contribution: claim.contribution,
      }),
    ),
  );
}

/** Candidates whose claims are already reserved, with every load outcome settled. */
export type ResolvedProviderPlugins = Readonly<{
  /** The connection callbacks of every loaded provider claim, by provider. */
  connections: ReadonlyMap<string, RegisteredConnection>;
  /** Every provider id claimed, including failed and dormant plugins. */
  claimedProviders: readonly string[];
  inventory(): readonly PluginInventoryEntry[];
  /** Every claim the registry holds, with its contribution and owning candidate. */
  claims: readonly ResolvedClaim[];
  /** @internal Consumed by {@link startProviderRegistry}, which owns setup and cleanup. */
  slots: readonly Slot[];
}>;

export type ProviderRegistry = Readonly<{
  registrations: readonly ProviderRegistration[];
  platforms: readonly RegisteredPlatformSetup[];
  resolvePlatform(
    family: OptionalPlatform,
    reportAbsent: (family: OptionalPlatform) => AppError,
    packageName?: string,
  ): RegisteredPlatformSetup;
  resolveReplayBackend: ReplayBackendResolver;
  resolveReplayExecution: ReplayExecutionResolver;
  claimedProviders: readonly string[];
  inventory: readonly PluginInventoryEntry[];
  /**
   * The one cleanup owner. Closes activated registrations in reverse activation order, shutting
   * each runtime down before its disposer, and reports what happened to each. It runs once; later
   * calls return the same outcomes. It never throws and never wraps a runtime.
   */
  close(): Promise<readonly PluginCleanupOutcome[]>;
}>;

/**
 * Loads and validates the candidates in order. Each one reserves its declared claims first, so the
 * first candidate to name a claim keeps it even when that claim later fails; a later one with the
 * same claim is recorded as failed. A plugin that cannot load never stops the others.
 */
export async function resolveProviderPlugins(
  candidates: readonly PluginCandidate[],
): Promise<ResolvedProviderPlugins> {
  const slots: Slot[] = [];
  const claimed: ClaimedClaims = new Map();
  for (const candidate of candidates) {
    const slot: Slot = { candidate, claims: [] };
    slots.push(slot);
    await reserveDeclaredClaims(slot, claimed, !candidate.dormant);
    if (!candidate.dormant) await loadSlot(slot, claimed);
  }

  return Object.freeze({
    connections: new Map(
      slots.flatMap(({ claims }) =>
        claims.flatMap((claim) => {
          if (claim.kind !== 'provider' || claim.failure !== undefined) return [];
          const connection = (claim.contribution as ProviderContribution | undefined)?.connection;
          return connection
            ? [
                [
                  claim.id,
                  withConnectionHost(connection, claim.slot.candidate.hostOptions),
                ] as const,
              ]
            : [];
        }),
      ),
    ),
    claimedProviders: [...(claimed.get('provider') ?? [])],
    inventory: () => slots.flatMap(describeSlot),
    claims: Object.freeze(claimsOf(slots)),
    slots,
  });
}

/**
 * Reserves each declared claim in its own space, in deterministic candidate order. The first claim
 * of a kind and id wins; a later one is recorded as failed against its own slot, and so is a claim of
 * an id the host reserves. A dormant slot holds its claims without listing them.
 */
async function reserveDeclaredClaims(
  slot: Slot,
  claimed: ClaimedClaims,
  list: boolean,
): Promise<void> {
  for (const claim of slot.candidate.declaredClaims ?? []) {
    const obstacle = await claimObstacle(claimed, claim);
    if (obstacle !== undefined) {
      if (list) slot.claims.push({ ...claim, slot, failure: obstacle });
      continue;
    }
    if (list) slot.claims.push({ ...claim, slot });
  }
}

/**
 * Why this claim cannot be held: its id belongs to the host, or its space already names it. Nothing
 * is reserved when there is an obstacle.
 */
async function claimObstacle(
  claimed: ClaimedClaims,
  claim: PluggedClaim,
): Promise<AppError | undefined> {
  const reserved = await reservedClaimError(claim);
  if (reserved !== undefined) return reserved;
  return reserveClaim(claimed, claim) ? undefined : duplicateClaimError(claim);
}

/** Whether this claim's space had not been named yet, which is what keeps the claim for its slot. */
function reserveClaim(claimed: ClaimedClaims, claim: PluggedClaim): boolean {
  let ids = claimed.get(claim.kind);
  if (ids === undefined) claimed.set(claim.kind, (ids = new Set()));
  if (ids.has(claim.id)) return false;
  ids.add(claim.id);
  return true;
}

/**
 * Runs one slot's factory and matches its contributions to the claims already reserved for the slot.
 * A slot that declares no claims claims what its factory returns, so an embedder's plugin competes
 * for the same spaces the same way.
 */
async function loadSlot(slot: Slot, claimed: ClaimedClaims): Promise<void> {
  let raw: unknown;
  try {
    raw = await slot.candidate.load();
    const returnedClaims = await validateAgentDevicePlugin(raw);
    assertDeclaredClaims(slot.candidate, returnedClaims);
    for (const { contribution, ...claim } of returnedClaims) {
      const reserved = slot.claims.find(
        (entry) => entry.contribution === undefined && claimKeyOf(entry) === claimKeyOf(claim),
      );
      if (reserved !== undefined) {
        reserved.contribution = contribution;
        continue;
      }
      const obstacle = reserveClaim(claimed, claim) ? undefined : duplicateClaimError(claim);
      slot.claims.push({
        ...claim,
        slot,
        contribution,
        ...(obstacle !== undefined ? { failure: obstacle } : {}),
      });
    }
  } catch (error) {
    slot.failure = asPluginFailure(error, 'plugin_load_failed');
    for (const claim of slot.claims) {
      // A reservation reason (a duplicate or reserved id) is the actionable one; keep it.
      if (claim.contribution === undefined) claim.failure ??= slot.failure;
    }
    await nameFailedClaims(slot, claimed, raw);
  }
}

/**
 * Names the claims of a slot that failed before its contributions were readable, from the value it
 * returned, and holds them: what the inventory reports and what a selection resolves must still say
 * what this plugin was meant to provide. A slot whose metadata already declared its claims was named
 * before the load and is left alone. Each claim carries the slot's own reason, which is the one the
 * author can act on.
 */
async function nameFailedClaims(slot: Slot, claimed: ClaimedClaims, raw: unknown): Promise<void> {
  if (slot.candidate.declaredClaims !== undefined || slot.claims.length > 0) return;
  for (const claim of await readableClaimsOfValue(raw)) {
    reserveClaim(claimed, claim);
    slot.claims.push({ ...claim, slot, failure: slot.failure });
  }
}

/** After the factory runs, declared and returned claims must be exactly equal, unordered. */
function assertDeclaredClaims(candidate: PluginCandidate, returned: readonly PluggedClaim[]): void {
  const declared = candidate.declaredClaims;
  if (declared === undefined) return;
  const sortedDeclared = declared.map(claimKeyOf).sort();
  const sortedReturned = returned.map(claimKeyOf).sort();
  if (
    sortedDeclared.length !== sortedReturned.length ||
    sortedDeclared.some((key, index) => key !== sortedReturned[index])
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `Plugin factory claims do not match its package metadata: ${candidate.package ?? 'candidate'}`,
      {
        reason: 'invalid_plugin',
        declared: sortedDeclared,
        returned: sortedReturned,
      },
    );
  }
}

type RegistryScope = 'all' | 'replay-backends' | 'platforms';

/**
 * Sets up every loaded claim in order. A claim whose setup throws, or returns a result the registry
 * refuses, is cleaned up and recorded as failed; the remaining claims still activate, so a broken
 * provider never disables a replay claim from the same package. The provider path sets up provider
 * claims only; the replay path sets up replay claims only.
 */
export async function startProviderRegistry(
  resolved: ResolvedProviderPlugins,
  host: HostEnvironment,
  policy: PluginRegistryPolicy,
  scope: RegistryScope = 'all',
): Promise<ProviderRegistry> {
  await setUpClaims(resolved.slots, host, policy, scope);
  const registrations = resolved.slots.flatMap(({ claims }) =>
    claims.flatMap(({ registration }) => (registration ? [registration] : [])),
  );
  let closed = false;
  const inventory = [...resolved.inventory()];
  const refreshInventory = () => inventory.splice(0, inventory.length, ...resolved.inventory());
  return Object.freeze({
    registrations,
    platforms: Object.freeze(
      resolved.slots.flatMap(({ claims }) =>
        claims.flatMap(({ platformSetup }) => (platformSetup ? [platformSetup] : [])),
      ),
    ),
    resolvePlatform: (family, reportAbsent, packageName) => {
      if (closed)
        throw new AppError('COMMAND_FAILED', 'Plugin registry is closed', {
          reason: 'plugin-registry-closed',
        });
      const claim = findClaim(
        resolved,
        { kind: 'platform', id: family },
        packageName,
        policy.assertSelectionCurrent,
      );
      if (!claim) throw reportAbsent(family);
      if (claim.failure !== undefined) {
        throw platformClaimError(claim);
      }
      if (!claim.platformSetup) throw invalidPlugin(`Platform was not set up: ${family}`);
      return claim.platformSetup;
    },
    claimedProviders: resolved.claimedProviders,
    inventory,
    resolveReplayBackend: async (id, host, packageName) => {
      if (closed)
        throw new AppError('COMMAND_FAILED', 'Plugin registry is closed', {
          reason: 'plugin-registry-closed',
        });
      const claim = requireReplayClaim(
        resolved,
        { kind: 'replay-backend', id },
        packageName,
        policy.assertSelectionCurrent,
      );
      return await resolveRegisteredReplayBackend(claim, refreshInventory, host);
    },
    resolveReplayExecution: async (packageName) => {
      const { NATIVE_REPLAY_BACKEND } = await import('@agent-device/contracts/replay-execution');
      if (closed)
        throw new AppError('COMMAND_FAILED', 'Plugin registry is closed', {
          reason: 'plugin-registry-closed',
        });
      const claim = requireReplayClaim(
        resolved,
        { kind: 'replay-execution', id: NATIVE_REPLAY_BACKEND },
        packageName,
        policy.assertSelectionCurrent,
      );
      return await resolveRegisteredReplayExecution(claim, refreshInventory);
    },
    // Reverse activation order, per ADR 0034: a claim activated later starts its teardown first,
    // and each runtime shuts down before its own disposer. Claims own independent resources, so
    // their teardowns run concurrently and one hanging disposer cannot stall the others.
    close: once(async () => {
      closed = true;
      const activated = resolved.slots.flatMap(({ claims }) =>
        claims.filter(
          (claim) =>
            claim.registration !== undefined ||
            claim.replaySetup !== undefined ||
            claim.platformSetup !== undefined,
        ),
      );
      return await Promise.all([...activated].reverse().map((claim) => cleanUpClaim(claim)));
    }),
  });
}

/**
 * Sets up every claim of every slot that has not already failed, in candidate order. The provider
 * path sets up provider claims only; the replay path sets up replay claims only.
 */
async function setUpClaims(
  slots: readonly Slot[],
  host: HostEnvironment,
  policy: PluginRegistryPolicy,
  scope: RegistryScope,
): Promise<void> {
  for (const slot of slots) {
    for (const claim of slot.claims) {
      if (claim.failure !== undefined) continue;
      try {
        await setUpClaim(claim, host, policy, scope);
      } catch (error) {
        claim.failure = asPluginFailure(error, 'plugin_setup_failed');
        claim.registration = undefined;
        claim.replaySetup = undefined;
        claim.platformSetup = undefined;
      }
    }
  }
}

async function setUpClaim(
  claim: Claim,
  host: HostEnvironment,
  policy: PluginRegistryPolicy,
  scope: RegistryScope,
): Promise<void> {
  const contribution = claim.contribution;
  if (contribution === undefined) {
    throw invalidPlugin(`Plugin claim has no contribution: ${claimKeyOf(claim)}`);
  }
  if (contribution.kind === 'provider') {
    if (scope === 'all') await setUpProviderClaim(claim, contribution, host, policy);
    return;
  }
  if (contribution.kind === 'platform') {
    if (scope === 'replay-backends') return;
    if (!policy.platformHost) throw invalidPlugin('Platform setup requires a platform host');
    const result = await contribution.setup(policy.platformHost);
    validateClaimSetup(claim, result);
    claim.platformSetup = Object.freeze(result as RegisteredPlatformSetup);
    return;
  }
  if (scope === 'platforms') return;
  const result = await contribution.setup(createReplaySetupHost());
  try {
    validateClaimSetup(claim, result);
    claim.replaySetup = result as ReplayBackendSetup | ReplayExecutionSetup;
  } catch (error) {
    await cleanUpRejectedSetup(result);
    throw error;
  }
}

async function resolveRegisteredReplayBackend(
  claim: Claim,
  refreshInventory: () => void,
  host: import('@agent-device/contracts/replay-backend').ReplayBackendHost,
): Promise<ReplayBackend> {
  if (claim.failure !== undefined) throw replayClaimError(claim);
  const replayBackend = (claim.replaySetup as ReplayBackendSetup | undefined)?.replayBackend;
  if (!replayBackend) throw invalidPlugin(`Replay backend was not set up: ${claim.id}`);
  return await (claim.replayLoading ??= Promise.resolve().then(async () => {
    try {
      const backend = validateReplayBackend(claim.id, await replayBackend.create(host));
      claim.replayFailure = undefined;
      refreshInventory();
      return backend;
    } catch (error) {
      claim.replayLoading = undefined;
      claim.replayFailure = asPluginFailure(error, 'plugin_load_failed');
      refreshInventory();
      throw replayClaimError(claim);
    }
  }));
}

async function resolveRegisteredReplayExecution(
  claim: Claim,
  refreshInventory: () => void,
): Promise<ReplayExecution> {
  if (claim.failure !== undefined) throw replayClaimError(claim);
  const execution = (claim.replaySetup as ReplayExecutionSetup | undefined)?.execution;
  if (!execution) throw invalidPlugin('Native replay plugin must provide execution.create()');
  return await (claim.executionLoading ??= Promise.resolve().then(async () => {
    try {
      const runtime = validateReplayExecution(await execution.create());
      claim.replayFailure = undefined;
      refreshInventory();
      return runtime;
    } catch (error) {
      claim.executionLoading = undefined;
      claim.replayFailure = asPluginFailure(error, 'plugin_load_failed');
      refreshInventory();
      throw replayClaimError(claim);
    }
  }));
}

/** The store selection owns a store-sourced slot's claim, whatever its outcome. */
function assertStoreSelectionCurrent(
  slot: Slot,
  assertSelectionCurrent: ((packageName: string) => void) | undefined,
): void {
  if (slot.candidate.source !== 'store' || slot.candidate.package === undefined) return;
  assertSelectionCurrent?.(slot.candidate.package);
}

/**
 * The claim a resolution answers, in candidate order, so the first candidate that named it
 * owns what a resolution surfaces. A candidate that failed before its claims were readable still
 * answers for the selection that named it, so a chosen plugin keeps its own reason instead of
 * reporting absence.
 */
function findClaim(
  resolved: ResolvedProviderPlugins,
  claim: PluggedClaim,
  packageName: string | undefined,
  assertSelectionCurrent?: (packageName: string) => void,
): Claim | undefined {
  const wanted = claimKeyOf(claim);
  for (const slot of resolved.slots) {
    const held = slot.claims.find((entry) => claimKeyOf(entry) === wanted);
    if (held === undefined) continue;
    assertStoreSelectionCurrent(slot, assertSelectionCurrent);
    return held;
  }
  // A store package that failed before it could name any claim still answers for the name its
  // selection chose, so a chosen plugin never reports that it is absent.
  const failedSlot = resolved.slots.find(
    (slot) =>
      packageName !== undefined &&
      slot.candidate.package === packageName &&
      slot.claims.length === 0 &&
      slot.failure !== undefined,
  );
  if (failedSlot) {
    assertStoreSelectionCurrent(failedSlot, assertSelectionCurrent);
    return { ...claim, slot: failedSlot, failure: failedSlot.failure };
  }
  if (packageName) assertSelectionCurrent?.(packageName);
  return undefined;
}

function requireReplayClaim(
  resolved: ResolvedProviderPlugins,
  claim: PluggedClaim,
  packageName: string | undefined,
  assertSelectionCurrent?: (packageName: string) => void,
): Claim {
  const found = findClaim(resolved, claim, packageName, assertSelectionCurrent);
  if (found) return found;
  throw new AppError('INVALID_ARGS', `Replay backend is not installed: ${claim.id}`, {
    reason: 'plugin-not-installed',
    backend: claim.id,
  });
}

function platformClaimError(claim: Claim): AppError {
  const error = asPluginFailure(claim.failure, 'plugin_load_failed');
  return new AppError(
    error.code,
    error.message,
    { ...error.details, ...identityOfClaim(claim), package: claim.slot.candidate.package },
    error,
  );
}

function replayClaimError(claim: Claim): AppError {
  const error = asPluginFailure(claim.failure ?? claim.replayFailure, 'plugin_load_failed');
  const packageName = claim.slot.candidate.package;
  return new AppError(
    error.code,
    error.message,
    {
      ...error.details,
      ...(packageName
        ? {
            package: packageName,
            updateCommand: `agent-device plugins update ${packageName}`,
            hint: `Repair or update ${packageName} on this host, then restart the daemon and retry the original invocation with all its arguments.`,
          }
        : {
            hint: 'Repair the supplied replay plugin, then close and recreate the embedded runtime. Retry the original invocation with all its arguments.',
          }),
    },
    error,
  );
}

async function cleanUpClaim(claim: Claim): Promise<PluginCleanupOutcome> {
  if (claim.registration) {
    const { provider, source, runtime, dispose } = claim.registration;
    const shutdown = await attempt(async () => await runtime.shutdown());
    const disposed = await attempt(async () => await dispose?.());
    return { provider, source, shutdown, dispose: disposed };
  }
  const setup = claim.replaySetup;
  const identity = identityOfClaim(claim);
  if (!setup)
    return {
      ...identity,
      source: claim.slot.candidate.source,
      shutdown: { status: 'ok' },
      dispose: { status: 'ok' },
    };
  await (claim.replayLoading ?? claim.executionLoading)?.catch(() => {});
  return {
    ...identity,
    source: claim.slot.candidate.source,
    shutdown: { status: 'ok' },
    dispose: await attempt(async () => await setup.dispose?.()),
  };
}

/**
 * A plugin's connection with the host it declares added to each context. Exported for the composing
 * root: a built-in provider wires its plugin's callbacks to a CLI call through the same helper the
 * registry uses, so both answer `connect` identically.
 */
export function withConnectionHost(
  connection: PluginConnection,
  hostOptions: Record<string, unknown> | undefined,
): RegisteredConnection {
  return {
    capabilities: connection.capabilities,
    resolve: (context) =>
      connection.resolve({
        ...context,
        host: createPluginHost({ env: context.env, cwd: context.cwd }, hostOptions),
      }),
    verify: (context) =>
      connection.verify({
        ...context,
        host: createPluginHost({ env: context.env, cwd: context.cwd }, hostOptions),
      }),
  };
}

async function setUpProviderClaim(
  claim: Claim,
  contribution: ProviderContribution,
  host: HostEnvironment,
  policy: PluginRegistryPolicy,
): Promise<void> {
  const pluginHost = createPluginHost(host, claim.slot.candidate.hostOptions);
  const result = await contribution.setup(pluginHost);
  try {
    const { runtime, platformModule } = await buildRegistration(
      contribution,
      result,
      pluginHost.clientVersion,
      policy,
    );
    const dispose = result.dispose?.bind(result);
    claim.registration = {
      provider: contribution.provider,
      source: claim.slot.candidate.source,
      runtime,
      platformModule,
      ...(dispose ? { dispose } : {}),
    };
  } catch (error) {
    await cleanUpRejectedSetup(result);
    throw error;
  }
}

async function buildRegistration(
  contribution: ProviderContribution,
  result: PluginSetupResult,
  clientVersion: string,
  policy: PluginRegistryPolicy,
): Promise<Pick<ProviderRegistration, 'runtime' | 'platformModule'>> {
  if (!isRecord(result))
    throw invalidPlugin(`Plugin setup must return a runtime: ${contribution.provider}`);
  if (isWebDriverSetup(result)) {
    if (result.webDriver?.provider !== contribution.provider) {
      throw invalidPlugin(
        `WebDriver plugin provider does not match its declaration: ${contribution.provider}`,
      );
    }
    return await policy.adaptWebDriver(result.webDriver, { clientVersion });
  }
  // The public contract names only what registration reads; the host checks the facets it calls.
  const { runtime, platformModule } = result as unknown as {
    runtime: ProviderDeviceRuntime;
    platformModule: PlatformRuntimeProviderModule;
  };
  assertProviderRuntime(contribution.provider, runtime, platformModule);
  return { runtime, platformModule };
}

function isWebDriverSetup(result: PluginSetupResult): result is PluginWebDriverSetup {
  return 'webDriver' in result;
}

async function cleanUpRejectedSetup(result: unknown): Promise<void> {
  if (!isRecord(result)) return;
  const runtime = result.runtime as ProviderDeviceRuntime | undefined;
  // The same order a registered plugin shuts down in: the runtime first, then `dispose`.
  try {
    if (typeof runtime?.shutdown === 'function') await runtime.shutdown();
  } catch {}
  try {
    if (typeof result.dispose === 'function') await (result.dispose as () => unknown)();
  } catch {}
}

/** A thrown value that is not already typed becomes a typed failure the inventory can key on. */
function asPluginFailure(error: unknown, reason: 'plugin_load_failed' | 'plugin_setup_failed') {
  if (error instanceof AppError) {
    return typeof error.details?.reason === 'string'
      ? error
      : new AppError(error.code, error.message, { ...error.details, reason }, error);
  }
  return new AppError(
    'COMMAND_FAILED',
    error instanceof Error ? error.message : String(error),
    { reason },
    error,
  );
}

function describeSlot(slot: Slot): PluginInventoryEntry[] {
  if (slot.candidate.dormant) return [];
  if (slot.claims.length > 0) return slot.claims.flatMap(describeClaim);
  return [
    {
      source: slot.candidate.source,
      ...identityOfCandidate(slot.candidate),
      state: 'failed',
      error: describePluginFailure(slot.failure),
      credentials: NO_PLUGIN_CREDENTIALS,
    },
  ];
}

function describeClaim(claim: Claim): PluginInventoryEntry[] {
  const failure = claim.failure ?? claim.replayFailure;
  const { candidate } = claim.slot;
  const base = {
    ...identityOfClaim(claim),
    source: candidate.source,
    ...identityOfCandidate(candidate),
  };
  if (failure !== undefined) {
    return [
      {
        ...base,
        state: 'failed',
        error: describePluginFailure(failure),
        credentials: NO_PLUGIN_CREDENTIALS,
      },
    ];
  }
  return [
    {
      ...base,
      state: 'active',
      credentials: claimCredentials(claim.contribution),
    },
  ];
}

function identityOfCandidate(candidate: PluginCandidate): {
  package?: string;
  version?: string;
} {
  return {
    ...(candidate.package !== undefined ? { package: candidate.package } : {}),
    ...(candidate.version !== undefined ? { version: candidate.version } : {}),
  };
}

function claimCredentials(contribution: Contribution | undefined) {
  if (contribution?.kind !== 'provider') return NO_PLUGIN_CREDENTIALS;
  return {
    variables: [...contribution.credentials.variables],
    byBackend: Object.fromEntries(
      Object.entries(contribution.credentials.byBackend ?? {}).map(([backend, names]) => [
        backend,
        [...names],
      ]),
    ),
  };
}

async function attempt(step: () => Promise<unknown>): Promise<PluginCleanupStep> {
  try {
    await step();
    return { status: 'ok' };
  } catch (error) {
    return { status: 'failed', error: describePluginFailure(error) };
  }
}

function once<T>(run: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined;
  return () => (started ??= run());
}

export type { RegisteredPlatformSetup } from './platform.ts';
