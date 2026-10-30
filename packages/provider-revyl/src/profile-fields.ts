import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';
import { REVYL_PROVIDER } from './device.ts';

/**
 * How Revyl treats each connect profile flag. Revyl starts a device from the platform, an optional
 * app URL, a model name and an OS version, so the app and OS-version flags are consumed and
 * everything the cloud does not accept is refused. The model comes from `--device`, which is not a
 * provider field; `--provider-device-type` selects a TestMu AI device pool, which Revyl has none of.
 */
export const REVYL_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: REVYL_PROVIDER,
  label: 'Revyl',
  fields: {
    providerApp: 'consumed',
    providerOsVersion: 'consumed',
    providerDeviceType: 'refused',
    providerProject: 'refused',
    providerBuild: 'refused',
    providerSessionName: 'refused',
    providerDeviceOrientation: 'refused',
    providerGeoLocation: 'refused',
    providerTimezone: 'refused',
    providerAppiumVersion: 'refused',
    providerLanguage: 'refused',
    providerLocale: 'refused',
    providerNetworkProfile: 'refused',
    providerCustomNetwork: 'refused',
    providerNoResignApp: 'refused',
    providerNetworkLogs: 'refused',
    providerNetworkHosts: 'refused',
    awsProjectArn: 'refused',
    awsDeviceArn: 'refused',
    awsAppArn: 'refused',
    awsRegion: 'refused',
    awsInteractionMode: 'refused',
  },
};
