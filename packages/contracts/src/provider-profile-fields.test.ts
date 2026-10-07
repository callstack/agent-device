import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import {
  rejectRefusedProviderProfileFields,
  type ProviderProfileFieldDeclaration,
} from './provider-profile-fields.ts';

const DECLARATION: ProviderProfileFieldDeclaration = {
  provider: 'fake',
  label: 'Fake Cloud',
  fields: {
    providerApp: 'consumed',
    providerOsVersion: 'refused',
    providerDeviceType: 'consumed',
    providerProject: 'consumed',
    providerBuild: 'consumed',
    providerSessionName: 'consumed',
    providerDeviceOrientation: 'consumed',
    providerGeoLocation: 'refused',
    providerTimezone: 'consumed',
    providerAppiumVersion: 'consumed',
    providerLanguage: 'consumed',
    providerLocale: 'consumed',
    providerNetworkProfile: 'consumed',
    providerCustomNetwork: 'consumed',
    providerNoResignApp: 'refused',
    awsProjectArn: 'consumed',
    awsDeviceArn: 'consumed',
    awsAppArn: 'consumed',
    awsRegion: 'consumed',
    awsInteractionMode: 'consumed',
  },
};

test('consumed, unset, empty, and false fields pass', () => {
  assert.doesNotThrow(() => rejectRefusedProviderProfileFields(undefined, DECLARATION));
  assert.doesNotThrow(() =>
    rejectRefusedProviderProfileFields(
      {
        providerApp: 'app',
        providerOsVersion: '',
        providerGeoLocation: undefined,
        providerNoResignApp: false,
        unrelated: 'x',
      },
      DECLARATION,
    ),
  );
});

test('a refused field fails with its flag, its aliases, and the provider named', () => {
  assert.throws(
    () => rejectRefusedProviderProfileFields({ providerOsVersion: '18' }, DECLARATION),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === '--provider-os-version (--os-version) is not supported by Fake Cloud.' &&
      error.details?.provider === 'fake' &&
      JSON.stringify(error.details?.flags) === '["--provider-os-version"]',
  );
});

test('every refused field is reported at once', () => {
  assert.throws(
    () =>
      rejectRefusedProviderProfileFields(
        { providerGeoLocation: 'US', providerNoResignApp: true, providerOsVersion: '18' },
        DECLARATION,
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.message ===
        '--provider-os-version (--os-version), --provider-geo-location (--geo-location), --provider-no-resign-app are not supported by Fake Cloud.' &&
      JSON.stringify(error.details?.flags) ===
        '["--provider-os-version","--provider-geo-location","--provider-no-resign-app"]',
  );
});
