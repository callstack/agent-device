import { AppError } from '@agent-device/kernel/errors';
import type { CloudProviderProfileFields } from './remote-config-fields.ts';

export type ProviderProfileField = keyof CloudProviderProfileFields;

/**
 * What one lease provider does with every Cloud provider profile field. The record is total, so a
 * field added to the profile fails to build until each provider says whether it consumes it; a
 * field a provider neither reads nor refuses would otherwise ride the profile and be dropped.
 */
export type ProviderProfileFieldDeclaration = Readonly<{
  provider: string;
  label: string;
  fields: Readonly<Record<ProviderProfileField, 'consumed' | 'refused'>>;
}>;

const PROVIDER_PROFILE_FIELD_FLAGS: Readonly<Record<ProviderProfileField, string>> = {
  providerApp: '--provider-app',
  providerOsVersion: '--provider-os-version',
  providerDeviceType: '--provider-device-type',
  providerProject: '--provider-project',
  providerBuild: '--provider-build',
  providerSessionName: '--provider-session-name',
  providerDeviceOrientation: '--provider-device-orientation',
  providerGeoLocation: '--provider-geo-location',
  providerTimezone: '--provider-timezone',
  providerAppiumVersion: '--provider-appium-version',
  providerLanguage: '--provider-language',
  providerLocale: '--provider-locale',
  providerNetworkProfile: '--provider-network-profile',
  providerCustomNetwork: '--provider-custom-network',
  providerNoResignApp: '--provider-no-resign-app',
  awsProjectArn: '--aws-project-arn',
  awsDeviceArn: '--aws-device-arn',
  awsAppArn: '--aws-app-arn',
  awsRegion: '--aws-region',
  awsInteractionMode: '--aws-interaction-mode',
};

/**
 * Fails when `flags` set a profile field the provider refuses. Every route to a provider — connect,
 * `leases.allocate`, a hand-authored remote-config profile — runs this against the same declaration.
 */
export function rejectRefusedProviderProfileFields(
  flags: Readonly<Record<string, unknown>> | undefined,
  declaration: ProviderProfileFieldDeclaration,
): void {
  const refused = (Object.keys(declaration.fields) as ProviderProfileField[])
    .filter((field) => declaration.fields[field] === 'refused' && isSet(flags?.[field]))
    .map((field) => PROVIDER_PROFILE_FIELD_FLAGS[field]);
  if (refused.length === 0) return;
  const plural = refused.length !== 1;
  throw new AppError(
    'INVALID_ARGS',
    `${refused.join(', ')} ${plural ? 'are' : 'is'} not supported by ${declaration.label}.`,
    {
      hint: `Drop ${plural ? 'those flags' : 'the flag'} or use a provider that supports ${plural ? 'them' : 'it'}.`,
      provider: declaration.provider,
      flags: refused,
    },
  );
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== '';
}
