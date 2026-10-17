import type { CliFlags } from '@agent-device/contracts/command';
import type {
  ConnectionProviderCapabilities,
  ProviderConnectionVerification,
  RemoteConfigProfile,
} from '@agent-device/contracts/remote';
import type { ProviderPluginHost } from './host.ts';

/** The provider plugin contract version this module defines. */
export const PROVIDER_PLUGIN_API_VERSION = 2;

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

/** What the registry reads of a WebDriver descriptor; the composing root owns the rest. */
export type WebDriverDescriptor = Readonly<{ provider: string }>;

/**
 * A hosted WebDriver service. The host interprets the descriptor and builds the runtime; the
 * descriptor's type belongs to the composing root, so this package never names a provider.
 */
export type PluginWebDriverSetup<WebDriver extends WebDriverDescriptor = WebDriverDescriptor> =
  Readonly<{
    webDriver: WebDriver;
    dispose?(): Promise<void> | void;
  }>;

export type PluginSetupResult<WebDriver extends WebDriverDescriptor = WebDriverDescriptor> =
  | PluginRuntimeSetup
  | PluginWebDriverSetup<WebDriver>;

export type AgentDevicePlugin<WebDriver extends WebDriverDescriptor = WebDriverDescriptor> =
  Readonly<{
    apiVersion: typeof PROVIDER_PLUGIN_API_VERSION;
    /** Lowercase id; `cloud` and `proxy` are reserved routing identities. */
    provider: string;
    credentials: PluginCredentials;
    connection?: PluginConnection;
    /** Builds the runtime. Keep it free of network I/O and device allocation. */
    setup(
      host: ProviderPluginHost,
    ): Promise<PluginSetupResult<WebDriver>> | PluginSetupResult<WebDriver>;
  }>;

/**
 * The default export of a plugin package's `./agent-device` entry. The store calls it with
 * `config.json` `plugins[name].options`; a JS host calls it directly.
 */
export type AgentDevicePluginFactory<
  Options = Record<string, unknown>,
  WebDriver extends WebDriverDescriptor = WebDriverDescriptor,
> = (options?: Options) => AgentDevicePlugin<WebDriver> | Promise<AgentDevicePlugin<WebDriver>>;
