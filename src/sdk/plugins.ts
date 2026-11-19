import type {
  AgentDevicePlugin as ContractPlugin,
  AgentDevicePluginFactory as ContractPluginFactory,
  PluginSetupResult as ContractSetupResult,
  PluginWebDriverSetup as ContractWebDriverSetup,
} from '@agent-device/plugins/contract';
import type { CloudWebDriverProviderOptions } from '@agent-device/provider-webdriver/plugin';

export type {
  HostCommandResult,
  ProviderPluginHost,
  RunHostCommand,
} from '@agent-device/plugins/host';
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
export type AgentDevicePluginFactory<Options = Record<string, unknown>> = ContractPluginFactory<
  Options,
  CloudWebDriverProviderOptions
>;

export type { ReplayEnginePlugin, ReplayEngineSetup } from '@agent-device/plugins/replay-backend';
export type { ReplayBackend, ReplayBackendHost } from '@agent-device/contracts/replay-backend';

export type {
  ReplayExecution,
  ReplayExecutionPlugin,
  ReplayExecutionResolver,
} from '@agent-device/contracts/replay-execution';

export { addPluginArtifact } from '@agent-device/plugins/store';
