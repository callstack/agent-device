export {
  classifyAndroidInputOwner,
  classifyAndroidInputOwnership,
  isAndroidInputMethodOwnedNode,
  isFallbackAndroidInputMethodPackage,
  isFallbackAndroidInputMethodResource,
  parseAndroidInputMethodPackage,
  readAndroidActiveInputMethodPackage,
} from '../android-input-ownership.ts';
export type {
  AndroidInputOwner,
  AndroidInputOwnership,
  AndroidInputOwnershipSource,
} from '../android-input-ownership.ts';
export {
  ANDROID_SYSTEM_CHROME_PACKAGE,
  hasAndroidSystemChromeProvenance,
  isAndroidSystemChromeWindowResourceId,
  stripAndroidSystemChromeProvenance,
  stripAndroidSystemChromeProvenanceFromNode,
} from '../android-system-chrome.ts';
export type { AndroidSystemChromeProvenance } from '../android-system-chrome.ts';
export { assertAppleMultiTouchSupported } from '../apple-multitouch-support.ts';
export { emptyAudioProbeResult, normalizeAudioProbeRecord } from '../audio-probe-result.ts';
export type {
  AudioProbeResult,
  AudioProbeSource,
  EmptyAudioProbeResultOptions,
  NormalizeAudioProbeRecordOptions,
} from '../audio-probe-result.ts';
export {
  isAudioProbeSupportedDevice,
  isHostSystemAudioProbeDevice,
} from '../audio-probe-support.ts';
export type { PlatformPlugin } from '../platform-plugin.ts';
export { assertCommandPlatformExecution } from '../command-platform-execution.ts';
export type {
  CommandPlatformExecution,
  RuntimeUseDeclaration,
} from '../command-platform-execution.ts';
export type { PlatformGatedProviderResolverKey } from '../platform-providers.ts';
export type { RunnerLogicalLeaseContext } from '../runner-lease-context.ts';
export type {
  AppleToolHost,
  AppleToolRequest,
  AppleXcrunTool,
  HostCommandRequest,
  HostCommandResult,
  HostCommandRunner,
  HostToolchainPreparer,
  HostOperatingSystem,
  HostTemporaryTextFile,
  DeviceInventoryFileHost,
  DeviceInventoryHost,
  DeviceInventoryHostByFamily,
  DeviceInventoryHostFor,
  DeviceObservationSink,
  NativeAssetResolver,
  PlatformDiagnosticEvent,
  PlatformDiagnosticSink,
  PlatformProgressSink,
  PlatformProgressUpdate,
  ResolvedNativeAsset,
  PlatformRequestScope,
} from '../platform-runtime-host.ts';
export { createPlatformModuleRegistry, inventoryUse } from '../platform-module.ts';
export type {
  ComposedDeviceInventoryGateways,
  DeviceInventoryDiscovery,
  DeviceInventoryGateway,
  DeviceInventorySource,
  InventoryPlatformModule,
  InventoryUse,
  PlatformModuleMetadata,
  PlatformModuleRegistry,
  ProviderAwareDeviceInventoryGateway,
} from '../platform-module.ts';
