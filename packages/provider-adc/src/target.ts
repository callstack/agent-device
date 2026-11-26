import { AppError } from '@agent-device/kernel/errors';
import {
  rejectRefusedProviderProfileFields,
  type ProviderProfileFieldDeclaration,
} from '@agent-device/contracts/provider-profile-fields';

const profileFields: ProviderProfileFieldDeclaration = {
  provider: 'adc',
  label: 'ADC',
  fields: {
    providerApp: 'refused',
    providerOsVersion: 'refused',
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

export function formFactor(flags?: Readonly<Record<string, unknown>>) {
  rejectRefusedProviderProfileFields(flags, profileFields);
  if (flags?.platform && flags.platform !== 'android')
    throw new AppError('INVALID_ARGS', 'ADC requires Android.');
  if (flags?.target === 'tv') return 'tv';
  if (flags?.target && flags.target !== 'mobile')
    throw new AppError('INVALID_ARGS', 'ADC supports mobile and TV targets.');
  return 'phone';
}
