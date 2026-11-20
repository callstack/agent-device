import type {
  AgentDevicePlugin as ContractPlugin,
  AgentDevicePluginFactory as ContractPluginFactory,
  PluginSetupResult as ContractSetupResult,
  PluginWebDriverSetup as ContractWebDriverSetup,
  ProviderOnlyPlugin as ContractProviderOnlyPlugin,
} from '@agent-device/plugins/contract';
import type { CloudWebDriverProviderOptions } from '@agent-device/provider-webdriver/plugin';

export type {
  HostCommandResult,
  ProviderPluginHost,
  ReplaySetupHost,
  RunHostCommand,
} from '@agent-device/plugins/host';
export type {
  Contribution,
  PlatformContribution,
  PlatformHost,
  PlatformSetup,
  PluginConnection,
  PluginConnectionContext,
  PluginConnectionResolution,
  PluginCredentials,
  PluginPlatformModule,
  PluginProviderRuntime,
  PluginRuntimeSetup,
  ProviderContribution,
  ProviderOnlyPlugin,
} from '@agent-device/plugins/contract';

/** A hosted WebDriver service; the host builds the runtime from the descriptor. */
export type PluginWebDriverSetup = ContractWebDriverSetup<CloudWebDriverProviderOptions>;
export type PluginSetupResult = ContractSetupResult<CloudWebDriverProviderOptions>;
export type AgentDevicePlugin = ContractPlugin<CloudWebDriverProviderOptions>;
/**
 * A plugin whose only contribution is a `provider` claim. Provider packages declare this as the
 * factory return type so their published declarations stay within the provider branch and never
 * inline the replay branches' host types.
 */
export type ProviderAgentDevicePlugin = ContractProviderOnlyPlugin<CloudWebDriverProviderOptions>;
export type AgentDevicePluginFactory<Options = Record<string, unknown>> = ContractPluginFactory<
  Options,
  CloudWebDriverProviderOptions
>;

export type {
  ReplayBackendContribution,
  ReplayBackendSetup,
  ReplayExecutionContribution,
  ReplayExecutionSetup,
} from '@agent-device/plugins/replay-backend';
export type { ReplayBackend, ReplayBackendHost } from '@agent-device/contracts/replay-backend';

export type {
  ReplayExecution,
  ReplayExecutionPlugin,
  ReplayExecutionResolver,
} from '@agent-device/contracts/replay-execution';

export { addPluginArtifact } from '@agent-device/plugins/store';
