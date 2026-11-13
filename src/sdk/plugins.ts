import type {
  AgentDevicePlugin as ContractPlugin,
  AgentDevicePluginFactory as ContractPluginFactory,
  PluginSetupResult as ContractSetupResult,
  PluginWebDriverSetup as ContractWebDriverSetup,
} from '@agent-device/plugins/contract';
import type { CloudWebDriverProviderOptions } from '@agent-device/provider-webdriver/plugin';

export type { ProviderPluginHost } from '@agent-device/plugins/host';
export type {
  PluginConnection,
  PluginConnectionContext,
  PluginConnectionResolution,
  PluginCredentials,
  PluginPlatformModule,
  PluginProviderRuntime,
  PluginRuntimeSetup,
} from '@agent-device/plugins/contract';

/** A hosted WebDriver service; the host builds the runtime from the descriptor. */
export type PluginWebDriverSetup = ContractWebDriverSetup<CloudWebDriverProviderOptions>;
export type PluginSetupResult = ContractSetupResult<CloudWebDriverProviderOptions>;
export type AgentDevicePlugin = ContractPlugin<CloudWebDriverProviderOptions>;
export type ManagedPlugin =
  | AgentDevicePlugin
  | import('@agent-device/plugins/replay-backend').ReplayEnginePlugin;
export type AgentDevicePluginFactory<Options = Record<string, unknown>> = ContractPluginFactory<
  Options,
  CloudWebDriverProviderOptions
>;

export type { ReplayEnginePlugin, ReplayEngineSetup } from '@agent-device/plugins/replay-backend';
export type { ReplayBackend, ReplayBackendHost } from '@agent-device/contracts/replay-backend';
