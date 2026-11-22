export type {
  HostCommandResult,
  ProviderPluginHost,
  ReplaySetupHost,
  RunHostCommand,
} from '@agent-device/plugins/host';
export type {
  AgentDevicePlugin,
  AgentDevicePluginFactory,
  Contribution,
  MacOsPlatformLeafContribution,
  PlatformBackgroundCommand,
  PlatformBackgroundProcess,
  PlatformContribution,
  PlatformHost,
  PlatformOutputSink,
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
  ProviderOnlyPlugin as ProviderAgentDevicePlugin,
} from '@agent-device/plugins/contract';

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
