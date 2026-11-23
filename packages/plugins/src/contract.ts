import type { ReasonTable } from '@agent-device/kernel/errors';
import type { CliFlags } from '@agent-device/contracts/command';
import type {
  ConnectionProviderCapabilities,
  ProviderConnectionVerification,
  RemoteConfigProfile,
} from '@agent-device/contracts/remote';
import type { PlatformContribution } from './platform.ts';
import type { ProviderPluginHost } from './host.ts';
import type { ReplayBackendContribution, ReplayExecutionContribution } from './replay-backend.ts';

/**
 * Why a provider plugin was refused: discovery, validation, the store, and the registry all
 * answer from this one table.
 */
export const PLUGIN_REASONS = {
  // Two plugins claim one provider id, or a plugin claims an id that routing or a built-in provider owns.
  duplicateProvider: { reason: 'duplicate_provider' },
  // Two plugins claim the same replay backend.
  duplicateReplayBackend: { reason: 'duplicate_replay_backend' },
  // A request tries to load a plugin after the registry closed.
  registryClosed: { reason: 'plugin-registry-closed' },
  // The package exports no plugin entry or declares no provider contract this build can load.
  incompatiblePlugin: { reason: 'incompatible_plugin' },
  // The plugin's metadata or code could not be read, resolved, or loaded.
  loadFailed: { reason: 'plugin_load_failed' },
  // The plugin's `setup(host)` threw, or registering what it returned failed.
  setupFailed: { reason: 'plugin_setup_failed' },
  // A plugin claims a provider id reserved for daemon routing, `cloud` or `proxy`.
  reservedProvider: { reason: 'reserved_provider' },
  // The plugin package or what its code returns breaks the plugin contract: an invalid package entry,
  // package version, provider id, credentials or connection, no default factory or `setup(host)`,
  // or a runtime or WebDriver descriptor that lacks a required field.
  invalidPlugin: { reason: 'invalid_plugin' },
  // A plugin declares an unsupported API version or omits its API metadata.
  incompatiblePluginApi: { reason: 'incompatible-plugin-api' },
  // The running Node version is below the minimum a plugin declares.
  nodeBelowFloor: { reason: 'node-below-floor' },
  // A platform contribution requires a platform host for setup.
  platformHostMissing: { reason: 'platform_host_missing' },
  // A replay backend claims an id reserved for native execution.
  reservedReplayBackend: { reason: 'reserved_replay_backend' },
  // Two plugins claim the same platform family.
  duplicatePlatform: { reason: 'duplicate_platform' },
  // Two plugins claim the same replay execution id.
  duplicateReplayExecution: { reason: 'duplicate_replay_execution' },
} as const satisfies ReasonTable<'plugins'>;

/** One {@link PLUGIN_REASONS} spelling a plugin refusal may carry. */
export type PluginFailureReason = (typeof PLUGIN_REASONS)[keyof typeof PLUGIN_REASONS]['reason'];

/** The plugin contract version this module defines. Version 2 had no compatibility shim. */
export const PLUGIN_API_VERSION = 3;

/** Provider ids that name daemon routing; no plugin can claim either of them. */
export const ROUTING_PROVIDER_IDENTITIES: readonly string[] = ['cloud', 'proxy'];

/**
 * The environment variables a plugin reads credentials from. The host fingerprints their values to
 * refuse a lease when the shell holds different credentials than the daemon started with. List
 * nothing for credentials the embedder passes as factory options.
 */
export type PluginCredentials = Readonly<{
  variables: readonly string[];
  /** Narrows `variables` to what a lease on one backend reads, such as `android-instance`. */
  byBackend?: Readonly<Record<string, readonly string[]>>;
}>;

export type PluginConnectionContext = Readonly<{
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The same host `setup` receives, built from this call's `env`; no runtime is set up. */
  host: ProviderPluginHost;
}>;

export type PluginConnectionResolution = {
  profile: RemoteConfigProfile;
  extraFlags?: Partial<CliFlags>;
};

/** What `agent-device connect <provider>` asks the plugin; the host owns the connection state. */
export type PluginConnection = Readonly<{
  /** Local provider capabilities; `requiresRemoteDaemon` must be false. */
  capabilities: ConnectionProviderCapabilities;
  resolve(
    context: PluginConnectionContext,
  ): Promise<PluginConnectionResolution> | PluginConnectionResolution;
  verify(
    context: Pick<PluginConnectionContext, 'flags' | 'env' | 'host'>,
  ): Promise<ProviderConnectionVerification>;
}>;

/**
 * The provider runtime a plugin builds. This type names only `provider` and `shutdown`; the host
 * also requires `leaseLifecycle`, `ownsDevice`, `getInteractor` and `deviceInventoryProvider` from
 * the provider runtime contract before it registers the runtime.
 */
export type PluginProviderRuntime = Readonly<{
  provider: string;
  shutdown(): Promise<void>;
}>;

export type PluginPlatformModule = Readonly<{
  owner: Readonly<{ kind: 'provider-runtime'; provider: string; instance: string }>;
  loadRuntime(...args: never[]): Promise<unknown>;
}>;

/** A provider runtime the plugin builds itself. */
export type PluginRuntimeSetup = Readonly<{
  runtime: PluginProviderRuntime;
  platformModule: PluginPlatformModule;
  /** Called once when the daemon shuts the plugin down, after `runtime.shutdown()`. */
  dispose?(): Promise<void> | void;
}>;

/** A `provider` contribution declares an id and builds a runtime with a provider host. */
export type ProviderContribution = Readonly<{
  kind: 'provider';
  /** Lowercase id; `cloud` and `proxy` are reserved routing identities. */
  provider: string;
  credentials: PluginCredentials;
  connection?: PluginConnection;
  /** Builds the runtime. Keep it free of network I/O and device allocation. */
  setup(host: ProviderPluginHost): Promise<PluginRuntimeSetup> | PluginRuntimeSetup;
}>;

export type {
  MacOsPlatformLeafContribution,
  PlatformBackgroundCommand,
  PlatformBackgroundProcess,
  PlatformContribution,
  PlatformHost,
  PlatformOutputSink,
  PlatformSetup,
} from './platform.ts';

/** One independently activated claim a plugin declares. New kinds need an explicit decision. */
export type Contribution =
  | ProviderContribution
  | PlatformContribution
  | ReplayBackendContribution
  | ReplayExecutionContribution;

/**
 * The object a plugin factory returns: the contract version plus every contribution the package
 * claims. Each contribution activates and cleans up independently of the others. A package that
 * declares a single kind may narrow `C` (e.g. to `ProviderContribution`) so its published types
 * stay within that kind's branch of the union.
 */
export type AgentDevicePlugin<C extends Contribution = Contribution> = Readonly<{
  apiVersion: typeof PLUGIN_API_VERSION;
  contributes: readonly [C, ...C[]];
}>;

/**
 * A plugin whose only contribution is a `provider` claim. Provider packages declare this as the
 * factory return type so their published declarations stay within the provider branch of the
 * union.
 */
export type ProviderOnlyPlugin = AgentDevicePlugin<ProviderContribution>;

/**
 * The default export of a plugin package's `./agent-device` entry. The store calls it with
 * `config.json` `plugins[name].options`; a JS host calls it directly.
 */
export type AgentDevicePluginFactory<Options = Record<string, unknown>> = (
  options?: Options,
) => AgentDevicePlugin | Promise<AgentDevicePlugin>;
