import type { ReplayBackend } from '@agent-device/contracts/replay-backend';
import type {
  ReplayEnginePlugin,
  ReplayEngineSetup,
  ReplayBackendResolver,
} from './replay-backend.ts';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import type {
  AgentDevicePlugin,
  PluginConnection,
  PluginSetupResult,
  PluginWebDriverSetup,
  WebDriverDescriptor,
} from './contract.ts';
import type { RegisteredConnection } from './connection.ts';
import { createPluginHost } from './host.ts';
import {
  NO_PLUGIN_CREDENTIALS,
  type PluginCleanupOutcome,
  type PluginCleanupStep,
  type PluginInventoryEntry,
  type PluginSource,
} from '@agent-device/contracts/plugin-inventory';
import { describePluginFailure } from './inventory.ts';
import { isProviderId } from './discovery.ts';
import { ROUTING_PROVIDER_IDENTITIES } from './contract.ts';
import {
  assertProviderRuntime,
  invalidPlugin,
  validateAgentDevicePlugin,
  validateReplayEnginePlugin,
  validateReplayEngineSetup,
  validateReplayBackend,
} from './validate.ts';

/**
 * One plugin a source offers the registry. Sources differ only in how a candidate loads; the
 * registry validates, claims and sets up every candidate the same way.
 */
export type PluginCandidate = Readonly<{
  source: PluginSource;
  package?: string;
  version?: string;
  /** Claims `provider` before its load settles, so a later candidate with that id is a duplicate. Dormant candidates claim it without loading. */
  provider?: string;
  /** Claims `provider` without registering or listing: a built-in that is not configured. */
  dormant?: boolean;
  /** The `options` the store passes to the host when it calls the factory. */
  hostOptions?: Record<string, unknown>;
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

type Slot = {
  candidate: PluginCandidate;
  provider?: string;
  plugin?: AgentDevicePlugin;
  backend?: string;
  replayPlugin?: ReplayEnginePlugin;
  replaySetup?: ReplayEngineSetup;
  replayLoading?: Promise<ReplayBackend>;
  failure?: unknown;
  registration?: ProviderRegistration;
};

/** Candidates whose plugins loaded and validated, with duplicate providers already settled. */
export type ResolvedProviderPlugins = Readonly<{
  /** The connection callbacks of every loaded plugin, by provider. */
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
  claimedProviders: readonly string[];
  inventory: readonly PluginInventoryEntry[];
  /**
   * The one cleanup owner. Shuts down every registered runtime and then runs its plugin's
   * `dispose`, each plugin independently of the others, and reports what happened to each. It runs
   * once; later calls return the same outcomes. It never throws and never wraps a runtime.
   */
  close(): Promise<readonly PluginCleanupOutcome[]>;
}>;

/**
 * Loads and validates the candidates in order. The first candidate to name a provider claims it,
 * even when that candidate later fails; a later one with the same id is recorded as failed. A
 * plugin that cannot load never stops the others.
 */
export async function resolveProviderPlugins(
  candidates: readonly PluginCandidate[],
): Promise<ResolvedProviderPlugins> {
  const slots: Slot[] = [];
  const claimed = new Set<string>();
  const claimedBackends = new Set<string>();
  for (const candidate of candidates) {
    const slot: Slot = { candidate, provider: candidate.provider };
    slots.push(slot);
    if (candidate.dormant) {
      if (candidate.provider !== undefined) claimed.add(candidate.provider);
      continue;
    }
    await loadSlot(slot);
    claimBackend(slot, claimedBackends);
    claimProvider(slot, claimed);
  }

  return Object.freeze({
    connections: new Map(
      slots.flatMap(({ plugin, candidate }) =>
        plugin?.connection
          ? [
              [
                plugin.provider,
                withConnectionHost(plugin.connection, candidate.hostOptions),
              ] as const,
            ]
          : [],
      ),
    ),
    claimedProviders: [...claimed],
    inventory: () => slots.flatMap(describeSlot),
    slots,
  });
}

/**
 * Sets up every loaded plugin in order. A plugin whose setup throws, or returns a runtime the
 * registry refuses, is cleaned up and recorded as failed; the remaining plugins still register.
 */
export async function startProviderRegistry(
  resolved: ResolvedProviderPlugins,
  env: NodeJS.ProcessEnv,
  policy: PluginRegistryPolicy,
  scope: 'all' | 'replay-backends' = 'all',
): Promise<ProviderRegistry> {
  for (const slot of resolved.slots) {
    if (slot.failure !== undefined) continue;
    try {
      if (slot.replayPlugin) await setUpReplaySlot(slot, slot.replayPlugin, env);
      else if (slot.plugin && scope === 'all') await setUpSlot(slot, slot.plugin, env, policy);
    } catch (error) {
      slot.failure = asPluginFailure(error, 'plugin_setup_failed');
      slot.registration = undefined;
    }
  }
  const registrations = resolved.slots.flatMap(({ registration }) =>
    registration ? [registration] : [],
  );
  let closed = false;
  const inventory = [...resolved.inventory()];
  return Object.freeze({
    registrations,
    claimedProviders: resolved.claimedProviders,
    inventory,
    resolveReplayBackend: async (id, host, packageName) => {
      if (closed)
        throw new AppError('COMMAND_FAILED', 'Plugin registry is closed', {
          reason: 'plugin-registry-closed',
        });
      return await resolveRegisteredReplayBackend(resolved, inventory, id, host, packageName);
    },
    close: once(async () => {
      closed = true;
      const [providers, backends] = await Promise.all([
        Promise.all(registrations.map(cleanUp)),
        Promise.all(resolved.slots.map(cleanUpReplaySlot)),
      ]);
      return [...providers, ...backends.flat()];
    }),
  });
}

async function loadSlot(slot: Slot): Promise<void> {
  try {
    const raw = await slot.candidate.load();
    if (isRecord(raw) && raw.kind === 'replay-backend') {
      slot.provider = undefined;
      slot.backend = typeof raw.backend === 'string' ? raw.backend : undefined;
      slot.replayPlugin = validateReplayEnginePlugin(raw);
    } else {
      slot.provider = readProviderId(raw) ?? slot.candidate.provider;
      slot.plugin = validateAgentDevicePlugin(raw);
    }
  } catch (error) {
    slot.failure = asPluginFailure(error, 'plugin_load_failed');
  }
}

function claimBackend(slot: Slot, claimed: Set<string>): void {
  if (slot.backend === undefined) return;
  if (!claimed.has(slot.backend)) {
    claimed.add(slot.backend);
    return;
  }
  slot.replayPlugin = undefined;
  slot.failure ??= new AppError('INVALID_ARGS', `Duplicate replay backend: ${slot.backend}`, {
    reason: 'duplicate_replay_backend',
    backend: slot.backend,
  });
}

function claimProvider(slot: Slot, claimed: Set<string>): void {
  if (slot.provider === undefined || ROUTING_PROVIDER_IDENTITIES.includes(slot.provider)) return;
  if (!claimed.has(slot.provider)) {
    claimed.add(slot.provider);
    return;
  }
  slot.plugin = undefined;
  slot.failure ??= new AppError('INVALID_ARGS', `Duplicate provider plugin: ${slot.provider}`, {
    reason: 'duplicate_provider',
    provider: slot.provider,
  });
}

async function setUpReplaySlot(
  slot: Slot,
  plugin: ReplayEnginePlugin,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await plugin.setup(createPluginHost(env, slot.candidate.hostOptions));
  try {
    slot.replaySetup = validateReplayEngineSetup(result);
  } catch (error) {
    await cleanUpRejectedSetup(result);
    throw error;
  }
}

async function resolveRegisteredReplayBackend(
  resolved: ResolvedProviderPlugins,
  inventory: PluginInventoryEntry[],
  id: string,
  host: import('@agent-device/contracts/replay-backend').ReplayBackendHost,
  packageName?: string,
): Promise<ReplayBackend> {
  const slot =
    resolved.slots.find((slot) => slot.backend === id) ??
    resolved.slots.find(
      (slot) => packageName !== undefined && slot.candidate.package === packageName,
    );
  if (!slot)
    throw new AppError('INVALID_ARGS', `Replay backend is not installed: ${id}`, {
      reason: 'plugin-not-installed',
      backend: id,
    });
  if (slot.failure !== undefined) throw slot.failure;
  const setup = slot.replaySetup;
  if (!setup) throw invalidPlugin(`Replay backend was not set up: ${id}`);
  return await (slot.replayLoading ??= Promise.resolve().then(async () => {
    try {
      return validateReplayBackend(id, await setup.replayBackend.create(host));
    } catch (error) {
      slot.failure = asPluginFailure(error, 'plugin_load_failed');
      inventory.splice(0, inventory.length, ...resolved.inventory());
      throw slot.failure;
    }
  }));
}

async function cleanUpReplaySlot(slot: Slot): Promise<PluginCleanupOutcome[]> {
  const setup = slot.replaySetup;
  const plugin = slot.replayPlugin;
  if (!setup || !plugin) return [];
  await slot.replayLoading?.catch(() => {});
  return [
    {
      backend: plugin.backend,
      source: slot.candidate.source,
      shutdown: { status: 'ok' },
      dispose: await attempt(async () => await setup.dispose?.()),
    },
  ];
}

function withConnectionHost(
  connection: PluginConnection,
  hostOptions: Record<string, unknown> | undefined,
): RegisteredConnection {
  return {
    capabilities: connection.capabilities,
    resolve: (context) =>
      connection.resolve({ ...context, host: createPluginHost(context.env, hostOptions) }),
    verify: (context) =>
      connection.verify({ ...context, host: createPluginHost(context.env, hostOptions) }),
  };
}

async function setUpSlot(
  slot: Slot,
  plugin: AgentDevicePlugin,
  env: NodeJS.ProcessEnv,
  policy: PluginRegistryPolicy,
): Promise<void> {
  const host = createPluginHost(env, slot.candidate.hostOptions);
  const result = await plugin.setup(host);
  try {
    const { runtime, platformModule } = await buildRegistration(
      plugin,
      result,
      host.clientVersion,
      policy,
    );
    const dispose = result.dispose?.bind(result);
    slot.registration = {
      provider: plugin.provider,
      source: slot.candidate.source,
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
  plugin: AgentDevicePlugin,
  result: PluginSetupResult,
  clientVersion: string,
  policy: PluginRegistryPolicy,
): Promise<Pick<ProviderRegistration, 'runtime' | 'platformModule'>> {
  if (!isRecord(result))
    throw invalidPlugin(`Plugin setup must return a runtime: ${plugin.provider}`);
  if (isWebDriverSetup(result)) {
    if (result.webDriver?.provider !== plugin.provider) {
      throw invalidPlugin(
        `WebDriver plugin provider does not match its declaration: ${plugin.provider}`,
      );
    }
    return await policy.adaptWebDriver(result.webDriver, { clientVersion });
  }
  // The public contract names only what registration reads; the host checks the facets it calls.
  const { runtime, platformModule } = result as unknown as {
    runtime: ProviderDeviceRuntime;
    platformModule: PlatformRuntimeProviderModule;
  };
  assertProviderRuntime(plugin.provider, runtime, platformModule);
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
  const { candidate, plugin } = slot;
  if (candidate.dormant) return [];
  const base = {
    ...(slot.provider !== undefined ? { provider: slot.provider } : {}),
    ...(slot.backend !== undefined ? { backend: slot.backend } : {}),
    source: candidate.source,
    ...(candidate.package !== undefined ? { package: candidate.package } : {}),
    ...(candidate.version !== undefined ? { version: candidate.version } : {}),
  };
  if (slot.failure !== undefined || (!plugin && !slot.replayPlugin)) {
    return [
      {
        ...base,
        state: 'failed',
        error: describePluginFailure(slot.failure),
        credentials: NO_PLUGIN_CREDENTIALS,
      },
    ];
  }
  return [
    {
      ...base,
      state: 'active',
      credentials: {
        variables: [...(plugin?.credentials.variables ?? [])],
        byBackend: Object.fromEntries(
          Object.entries(plugin?.credentials.byBackend ?? {}).map(([backend, names]) => [
            backend,
            [...names],
          ]),
        ),
      },
    },
  ];
}

function readProviderId(raw: unknown): string | undefined {
  return isRecord(raw) && isProviderId(raw.provider) ? raw.provider : undefined;
}

async function cleanUp({
  provider,
  source,
  runtime,
  dispose,
}: ProviderRegistration): Promise<PluginCleanupOutcome> {
  const shutdown = await attempt(async () => await runtime.shutdown());
  const disposed = await attempt(async () => await dispose?.());
  return { provider, source, shutdown, dispose: disposed };
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
