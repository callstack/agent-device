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
export type { PlatformGatedProviderResolverKey } from '../platform-providers.ts';
export type { RunnerLogicalLeaseContext } from '../runner-lease-context.ts';
