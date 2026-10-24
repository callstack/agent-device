import type {
  ProviderProfileField,
  ProviderProfileFieldDeclaration,
} from '@agent-device/contracts/provider-profile-fields';

/** A test hub that reads every profile field, so no flag is refused. */
export function consumeAllProfileFields(provider: string): ProviderProfileFieldDeclaration {
  return {
    provider,
    label: provider,
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
      providerNetworkProfile: 'consumed',
      providerCustomNetwork: 'consumed',
      providerNoResignApp: 'consumed',
      providerNetworkLogs: 'consumed',
      awsProjectArn: 'consumed',
      awsDeviceArn: 'consumed',
      awsAppArn: 'consumed',
      awsRegion: 'consumed',
      awsInteractionMode: 'consumed',
    },
  };
}

export function consumedProfileFields({ fields }: ProviderProfileFieldDeclaration): string[] {
  return (Object.keys(fields) as ProviderProfileField[])
    .filter((field) => fields[field] === 'consumed')
    .sort();
}
