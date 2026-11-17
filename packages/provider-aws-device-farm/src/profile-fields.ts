import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';
import { AWS_DEVICE_FARM_PROVIDER } from './providers.ts';

export const AWS_DEVICE_FARM_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: AWS_DEVICE_FARM_PROVIDER,
  label: 'AWS Device Farm',
  fields: {
    providerApp: 'refused',
    providerOsVersion: 'refused',
    providerDeviceType: 'refused',
    providerProject: 'refused',
    providerBuild: 'refused',
    providerSessionName: 'consumed',
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
    awsProjectArn: 'consumed',
    awsDeviceArn: 'consumed',
    awsAppArn: 'consumed',
    awsRegion: 'consumed',
    awsInteractionMode: 'consumed',
  },
};
