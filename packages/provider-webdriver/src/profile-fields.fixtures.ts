import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';

/** A test hub that reads every profile field, so no flag is refused. */
export function consumeAllProfileFields(provider: string): ProviderProfileFieldDeclaration {
  return {
    provider,
    label: provider,
    fields: {
      providerApp: 'consumed',
      providerOsVersion: 'consumed',
      providerProject: 'consumed',
      providerBuild: 'consumed',
      providerSessionName: 'consumed',
      providerDeviceOrientation: 'consumed',
      providerGeoLocation: 'consumed',
      providerTimezone: 'consumed',
      providerAppiumVersion: 'consumed',
      providerLanguage: 'consumed',
      providerLocale: 'consumed',
      providerNetworkProfile: 'consumed',
      providerCustomNetwork: 'consumed',
      providerNoResignApp: 'consumed',
      awsProjectArn: 'consumed',
      awsDeviceArn: 'consumed',
      awsAppArn: 'consumed',
      awsRegion: 'consumed',
      awsInteractionMode: 'consumed',
    },
  };
}
