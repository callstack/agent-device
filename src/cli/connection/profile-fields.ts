import type {
  CloudProviderProfileFields,
  RemoteConfigMetroOptions,
} from '@agent-device/contracts/remote';
import type { CliFlags } from '@agent-device/contracts/command';

/**
 * Hosted-provider device-feature fields (orientation, geolocation, locale, network shape, app
 * re-signing). Read as a group because every hosted-provider profile carries the same set, and the
 * capability projection for them lives with the provider, not here.
 */
export function readCloudDeviceFeatureProfileFields(
  flags: CliFlags,
): Pick<
  CloudProviderProfileFields,
  | 'providerDeviceOrientation'
  | 'providerGeoLocation'
  | 'providerTimezone'
  | 'providerLanguage'
  | 'providerLocale'
  | 'providerNetworkProfile'
  | 'providerCustomNetwork'
  | 'providerNoResignApp'
> {
  return {
    providerDeviceOrientation: flags.providerDeviceOrientation,
    providerGeoLocation: flags.providerGeoLocation,
    providerTimezone: flags.providerTimezone,
    providerLanguage: flags.providerLanguage,
    providerLocale: flags.providerLocale,
    providerNetworkProfile: flags.providerNetworkProfile,
    providerCustomNetwork: flags.providerCustomNetwork,
    providerNoResignApp: flags.providerNoResignApp,
  };
}

export function readMetroProfileFields(flags: CliFlags): RemoteConfigMetroOptions {
  return {
    metroProjectRoot: flags.metroProjectRoot,
    metroKind: flags.metroKind,
    metroPublicBaseUrl: flags.metroPublicBaseUrl,
    metroProxyBaseUrl: flags.metroProxyBaseUrl,
    metroPreparePort: flags.metroPreparePort,
    metroListenHost: flags.metroListenHost,
    metroStatusHost: flags.metroStatusHost,
    metroStartupTimeoutMs: flags.metroStartupTimeoutMs,
    metroProbeTimeoutMs: flags.metroProbeTimeoutMs,
    metroRuntimeFile: flags.metroRuntimeFile,
    metroNoReuseExisting: flags.metroNoReuseExisting,
    metroNoInstallDeps: flags.metroNoInstallDeps,
    launchUrl: flags.launchUrl,
  };
}
