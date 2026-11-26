import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';
import { SAUCE_LABS_PROVIDER, SAUCE_LABS_SERVICE } from './providers.ts';

export const SAUCE_LABS_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: SAUCE_LABS_PROVIDER,
  label: SAUCE_LABS_SERVICE,
  fields: {
    providerApp: 'consumed',
    providerOsVersion: 'consumed',
    providerDeviceType: 'refused',
    providerProject: 'refused',
    providerBuild: 'consumed',
    providerSessionName: 'consumed',
    providerDeviceOrientation: 'consumed',
    providerGeoLocation: 'refused',
    providerTimezone: 'refused',
    providerAppiumVersion: 'consumed',
    providerLanguage: 'refused',
    providerLocale: 'refused',
    providerNetworkProfile: 'refused',
    providerCustomNetwork: 'refused',
    providerNoResignApp: 'consumed',
    providerNetworkLogs: 'refused',
    providerNetworkHosts: 'refused',
    awsProjectArn: 'refused',
    awsDeviceArn: 'refused',
    awsAppArn: 'refused',
    awsRegion: 'refused',
    awsInteractionMode: 'refused',
  },
};
