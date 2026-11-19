import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { NATIVE_REPLAY_BACKEND } from '@agent-device/contracts/replay-execution';
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
  AgentDevicePlugin,
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
import { isProviderId } from './discovery.ts';
import {
  assertProviderRuntime,
  claimKeyOfContribution,
  invalidPlugin,
  validateAgentDevicePlugin,
  validateReplayBackend,
  validateReplayBackendSetup,
  validateReplayExecution,
  validateReplayExecutionSetup,
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
  /** Claims `provider` before its load settles, so a later candidate with that id is a duplicate. Dormant candidates claim it without loading. */
  provider?: string;
  /** Claims `provider` without registering or listing: a built-in that is not configured. */
  dormant?: boolean;
  /** The `options` the store passes to the host when it calls the factory. */
  hostOptions?: Record<string, unknown>;
  /**
   * The claim keys the package's `agent-device` metadata declares, read before import. After the
   * factory runs, the returned claim keys must equal these, in any order.
   */
  declaredClaims?: readonly string[];
  /** Returns the unvalidated plugin, or throws the reason it cannot load. */
  load(): Promise<unknown> | unknown;
}>;

/** Claims provider ids without loading anything, as the built-in sources do for their own. */
export function claimProviderIds(providers: readonly string[]): PluginCandidate[] {
  return providers.map((provider) => ({
    source: 'builtin',
    provider,
    dormant: true,
    load: () => undefined,
  }));
}

/**
 * What the composing root decides for every registry, so this package names no provider: how a
 * plugin's `{ webDriver }` descriptor becomes a runtime.
 */
export type PluginRegistryPolicy = Readonly<{
  assertReplaySelectionCurrent?(packageName: string): void;
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

type ClaimSpace = 'provider' | 'replay-backend' | 'replay-execution';

/** One contribution expanded into its own claim: its own record, setup outcome and cleanup entry. */
type Claim = {
  slot: Slot;
  space: ClaimSpace;
  key: string;
  contribution: Contribution;
  failure?: unknown;
  registration?: ProviderRegistration;
  replaySetup?: ReplayBackendSetup | ReplayExecutionSetup;
  replayLoading?: Promise<ReplayBackend>;
  executionLoading?: Promise<ReplayExecution>;
  replayFailure?: unknown;
};

type Slot = {
  candidate: PluginCandidate;
  plugin?: AgentDevicePlugin;
  /** Identity pre-read from an unloadable value, so the inventory can still name what failed. */
  provider?: string;
  backend?: string;
  failure?: unknown;
  claims: Claim[];
};

/** Candidates whose plugins loaded and validated, with every claim already settled. */
export type ResolvedProviderPlugins = Readonly<{
  /** The connection callbacks of every loaded provider claim, by provider. */
  connections: ReadonlyMap<string, RegisteredConnection>;
  /** Every provider id claimed, including failed and dormant plugins. */
  claimedProviders: readonly string[];
  inventory(): readonly PluginInventoryEntry[];
  /** @internal Consumed by {@link startProviderRegistry}. */
  slots: readonly Slot[];
}>;

export type ProviderRegistry = Readonly<{
  registrations: readonly ProviderRegistration[];
  resolveReplayBackend: ReplayBackendResolver;
  resolveReplayExecution: ReplayExecutionResolver;
  claimedProviders: readonly string[];
  inventory: readonly PluginInventoryEntry[];
  /**
   * The one cleanup owner. Closes activated registrations in reverse activation order, shutting
   * each runtime down before its disposer, each claim independently of the others, and reports
   * what happened to each. It runs once; later calls return the same outcomes. It never throws and
   * never wraps a runtime.
   */
  close(): Promise<readonly PluginCleanupOutcome[]>;
}>;

/**
 * Loads and validates the candidates in order. The whole declaration is validated, then expanded
 * into claims. The first candidate to name a claim keeps it, even when that claim later fails; a
 * later one with the same key is recorded as failed. A plugin that cannot load never stops the
 * others.
 */
export async function resolveProviderPlugins(
  candidates: readonly PluginCandidate[],
): Promise<ResolvedProviderPlugins> {
  const slots: Slot[] = [];
  const claimed = {
    provider: new Set<string>(),
    backend: new Set<string>(),
    execution: new Set<string>(),
  };
  for (const candidate of candidates) {
    const slot: Slot = { candidate, provider: candidate.provider, claims: [] };
    slots.push(slot);
    if (candidate.dormant) {
      if (candidate.provider !== undefined) claimed.provider.add(candidate.provider);
      continue;
    }
    await loadSlot(slot, claimed);
  }

  return Object.freeze({
    connections: new Map(
      slots.flatMap(({ claims }) =>
        claims.flatMap((claim) => {
          if (claim.space !== 'provider' || claim.failure !== undefined) return [];
          const connection = (claim.contribution as ProviderContribution).connection;
          return connection
            ? [
                [
                  claim.key,
                  withConnectionHost(connection, claim.slot.candidate.hostOptions),
                ] as const,
              ]
            : [];
        }),
      ),
    ),
    claimedProviders: [...claimed.provider],
    inventory: () => slots.flatMap(describeSlot),
    slots,
  });
}

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
  scope: 'all' | 'replay-backends' = 'all',
): Promise<ProviderRegistry> {
  for (const slot of resolved.slots) {
    for (const claim of slot.claims) {
      if (claim.failure !== undefined) continue;
      try {
        if (claim.space === 'provider') {
          if (scope === 'all') await setUpProviderClaim(claim, host, policy);
        } else {
          await setUpReplayClaim(claim);
        }
      } catch (error) {
        claim.failure = asPluginFailure(error, 'plugin_setup_failed');
        claim.registration = undefined;
        claim.replaySetup = undefined;
      }
    }
  }
  const registrations = resolved.slots.flatMap(({ claims }) =>
    claims.flatMap(({ registration }) => (registration ? [registration] : [])),
  );
  let closed = false;
  const inventory = [...resolved.inventory()];
  const refreshInventory = () => inventory.splice(0, inventory.length, ...resolved.inventory());
  return Object.freeze({
    registrations,
    claimedProviders: resolved.claimedProviders,
    inventory,
    resolveReplayBackend: async (id, host, packageName) => {
      if (closed)
        throw new AppError('COMMAND_FAILED', 'Plugin registry is closed', {
          reason: 'plugin-registry-closed',
        });
      const claim = requireReplayClaim(
        resolved,
        'replay-backend',
        id,
        packageName,
        policy.assertReplaySelectionCurrent,
      );
      return await resolveRegisteredReplayBackend(claim, refreshInventory, id, host);
    },
    resolveReplayExecution: async (packageName) => {
      if (closed)
        throw new AppError('COMMAND_FAILED', 'Plugin registry is closed', {
          reason: 'plugin-registry-closed',
        });
      const claim = requireReplayClaim(
        resolved,
        'replay-execution',
        NATIVE_REPLAY_BACKEND,
        packageName,
        policy.assertReplaySelectionCurrent,
      );
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
    },
    close: once(async () => {
      closed = true;
      const activated = resolved.slots.flatMap(({ claims }) =>
        claims.filter(
          (claim) => claim.registration !== undefined || claim.replaySetup !== undefined,
        ),
      );
      const outcomes: PluginCleanupOutcome[] = [];
      for (const claim of [...activated].reverse()) {
        outcomes.push(await cleanUpClaim(claim));
      }
      return outcomes;
    }),
  });
}

async function loadSlot(
  slot: Slot,
  claimed: { provider: Set<string>; backend: Set<string>; execution: Set<string> },
): Promise<void> {
  let raw: unknown;
  try {
    raw = await slot.candidate.load();
    const plugin = validateAgentDevicePlugin(raw);
    assertDeclaredClaims(slot.candidate, plugin);
    slot.plugin = plugin;
    for (const contribution of plugin.contributes) {
      const claim = makeClaim(slot, contribution);
      slot.claims.push(claim);
      reserveClaim(claim, claimed);
    }
  } catch (error) {
    slot.failure = asPluginFailure(error, 'plugin_load_failed');
    slot.provider = readProviderId(raw) ?? slot.candidate.provider;
    slot.backend = readBackendId(raw);
    // The first registration keeps its claim even when it fails: a pre-read identity still
    // reserves the claim, so a later candidate with the same id is the failed duplicate.
    if (slot.provider !== undefined) claimed.provider.add(slot.provider);
    if (slot.backend !== undefined) claimed.backend.add(slot.backend);
  }
}

function makeClaim(slot: Slot, contribution: Contribution): Claim {
  const key = claimKeyOfContribution(contribution);
  const space: ClaimSpace = key.startsWith('provider:')
    ? 'provider'
    : key.startsWith('replay-backend:')
      ? 'replay-backend'
      : 'replay-execution';
  return { slot, space, key: key.slice(key.indexOf(':') + 1), contribution };
}

/**
 * Reserves the claim in its space in deterministic candidate order. The first registration keeps
 * its claim even when it fails; later ones are recorded as failed. `ad` is reserved against format
 * claims: only a replay-execution contribution may claim it.
 */
function reserveClaim(
  claim: Claim,
  claimed: { provider: Set<string>; backend: Set<string>; execution: Set<string> },
): void {
  if (claim.space === 'replay-backend' && claim.key === NATIVE_REPLAY_BACKEND) {
    claim.failure = new AppError(
      'INVALID_ARGS',
      `Replay backend id is reserved for native execution: ${NATIVE_REPLAY_BACKEND}`,
      { reason: 'reserved_replay_backend', backend: NATIVE_REPLAY_BACKEND },
    );
    return;
  }
  const space =
    claim.space === 'provider'
      ? claimed.provider
      : claim.space === 'replay-backend'
        ? claimed.backend
        : claimed.execution;
  if (space.has(claim.key)) {
    claim.failure = new AppError('INVALID_ARGS', `Duplicate ${claim.space} claim: ${claim.key}`, {
      reason:
        claim.space === 'provider'
          ? 'duplicate_provider'
          : claim.space === 'replay-backend'
            ? 'duplicate_replay_backend'
            : 'duplicate_replay_execution',
      ...(claim.space === 'provider' ? { provider: claim.key } : { backend: claim.key }),
    });
    return;
  }
  space.add(claim.key);
}

/** After the factory runs, declared and returned claim keys must be exactly equal, unordered. */
function assertDeclaredClaims(candidate: PluginCandidate, plugin: AgentDevicePlugin): void {
  const declared = candidate.declaredClaims;
  if (declared === undefined) return;
  const returned = plugin.contributes.map((contribution) => claimKeyOfContribution(contribution));
  const sortedDeclared = [...declared].sort();
  const sortedReturned = [...returned].sort();
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

async function setUpReplayClaim(claim: Claim): Promise<void> {
  const contribution = claim.contribution;
  if (contribution.kind === 'provider') return;
  const result = await contribution.setup(createReplaySetupHost());
  try {
    claim.replaySetup =
      contribution.kind === 'replay-backend'
        ? validateReplayBackendSetup(result)
        : validateReplayExecutionSetup(result);
  } catch (error) {
    await cleanUpRejectedSetup(result);
    throw error;
  }
}

async function resolveRegisteredReplayBackend(
  claim: Claim,
  refreshInventory: () => void,
  id: string,
  host: import('@agent-device/contracts/replay-backend').ReplayBackendHost,
): Promise<ReplayBackend> {
  if (claim.failure !== undefined) throw replayClaimError(claim);
  const replayBackend = (claim.replaySetup as ReplayBackendSetup | undefined)?.replayBackend;
  if (!replayBackend) throw invalidPlugin(`Replay backend was not set up: ${id}`);
  return await (claim.replayLoading ??= Promise.resolve().then(async () => {
    try {
      const backend = validateReplayBackend(id, await replayBackend.create(host));
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

function requireReplayClaim(
  resolved: ResolvedProviderPlugins,
  space: ClaimSpace,
  id: string,
  packageName: string | undefined,
  assertSelectionCurrent?: (packageName: string) => void,
): Claim {
  // In candidate order: a slot's own claim first, then a failed load whose pre-read id matches,
  // so the first registration's failure is what a resolution surfaces.
  for (const slot of resolved.slots) {
    const claim = slot.claims.find((claim) => claim.space === space && claim.key === id);
    if (claim) {
      if (slot.candidate.source === 'store' && slot.candidate.package)
        assertSelectionCurrent?.(slot.candidate.package);
      return claim;
    }
    if (slot.claims.length === 0 && slot.failure !== undefined && slot.backend === id) {
      if (slot.candidate.source === 'store' && slot.candidate.package)
        assertSelectionCurrent?.(slot.candidate.package);
      return {
        slot,
        space,
        key: id,
        contribution: undefined as unknown as Contribution,
        failure: slot.failure,
      } satisfies Claim;
    }
  }
  // A selected package that failed before it could claim still answers for its own name.
  const failed = resolved.slots.find(
    (slot) =>
      packageName !== undefined &&
      slot.candidate.package === packageName &&
      slot.claims.length === 0 &&
      slot.failure !== undefined,
  );
  if (failed) {
    if (failed.candidate.source === 'store' && failed.candidate.package)
      assertSelectionCurrent?.(failed.candidate.package);
    return {
      slot: failed,
      space,
      key: id,
      contribution: undefined as unknown as Contribution,
      failure: failed.failure,
    } satisfies Claim;
  }
  if (packageName) assertSelectionCurrent?.(packageName);
  throw new AppError('INVALID_ARGS', `Replay backend is not installed: ${id}`, {
    reason: 'plugin-not-installed',
    backend: id,
  });
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
  if (!setup)
    return {
      backend: claim.key,
      source: claim.slot.candidate.source,
      shutdown: { status: 'ok' },
      dispose: { status: 'ok' },
    };
  await (claim.replayLoading ?? claim.executionLoading)?.catch(() => {});
  return {
    backend: claim.key,
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
  host: HostEnvironment,
  policy: PluginRegistryPolicy,
): Promise<void> {
  const contribution = claim.contribution as ProviderContribution;
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
  const { candidate } = slot;
  if (candidate.dormant) return [];
  if (slot.claims.length > 0) return slot.claims.flatMap(describeClaim);
  const base = {
    ...(slot.provider !== undefined ? { provider: slot.provider } : {}),
    ...(slot.backend !== undefined ? { backend: slot.backend } : {}),
    source: candidate.source,
    ...(candidate.package !== undefined ? { package: candidate.package } : {}),
    ...(candidate.version !== undefined ? { version: candidate.version } : {}),
  };
  return [
    {
      ...base,
      state: 'failed',
      error: describePluginFailure(slot.failure),
      credentials: NO_PLUGIN_CREDENTIALS,
    },
  ];
}

function describeClaim(claim: Claim): PluginInventoryEntry[] {
  const { candidate } = claim.slot;
  const base = {
    ...(claim.space === 'provider' ? { provider: claim.key } : { backend: claim.key }),
    source: candidate.source,
    ...(candidate.package !== undefined ? { package: candidate.package } : {}),
    ...(candidate.version !== undefined ? { version: candidate.version } : {}),
  };
  if (claim.failure !== undefined || claim.replayFailure !== undefined) {
    return [
      {
        ...base,
        state: 'failed',
        error: describePluginFailure(claim.failure ?? claim.replayFailure),
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

function claimCredentials(contribution: Contribution) {
  if (contribution.kind !== 'provider') return NO_PLUGIN_CREDENTIALS;
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

function readProviderId(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  if (isProviderId(raw.provider)) return raw.provider;
  if (Array.isArray(raw.contributes)) {
    for (const entry of raw.contributes) {
      if (isRecord(entry) && entry.kind === 'provider' && isProviderId(entry.provider))
        return entry.provider;
    }
  }
  return undefined;
}

function readBackendId(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  if (isProviderId(raw.backend)) return raw.backend;
  if (Array.isArray(raw.contributes)) {
    for (const entry of raw.contributes) {
      if (isRecord(entry) && entry.kind === 'replay-backend' && isProviderId(entry.backend))
        return entry.backend;
      if (isRecord(entry) && entry.kind === 'replay-execution') return NATIVE_REPLAY_BACKEND;
    }
  }
  return undefined;
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
