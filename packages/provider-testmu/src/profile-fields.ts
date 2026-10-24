import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';

export const TESTMU_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: 'testmu',
  label: 'TestMu AI',
  fields: {
    providerApp: 'consumed',
    providerOsVersion: 'consumed',
    providerDeviceType: 'consumed',
    providerProject: 'consumed',
    providerBuild: 'consumed',
    providerSessionName: 'consumed',
    providerDeviceOrientation: 'consumed',
    providerGeoLocation: 'consumed',
    providerTimezone: 'consumed',
    providerAppiumVersion: 'consumed',
    providerLanguage: 'consumed',
    providerLocale: 'consumed',
    providerNetworkProfile: 'refused',
    providerCustomNetwork: 'refused',
    providerNoResignApp: 'refused',
    providerNetworkLogs: 'consumed',
    awsProjectArn: 'refused',
    awsDeviceArn: 'refused',
    awsAppArn: 'refused',
    awsRegion: 'refused',
    awsInteractionMode: 'refused',
  },
};
