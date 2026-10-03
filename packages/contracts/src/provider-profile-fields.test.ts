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
    providerOsVersion: 'consumed',
    providerDeviceType: 'refused',
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
        providerDeviceType: '',
        providerGeoLocation: undefined,
        providerNoResignApp: false,
        unrelated: 'x',
      },
      DECLARATION,
    ),
  );
});

test('a refused field fails with its flag and the provider named', () => {
  assert.throws(
    () => rejectRefusedProviderProfileFields({ providerDeviceType: 'real' }, DECLARATION),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === '--provider-device-type is not supported by Fake Cloud.' &&
      error.details?.provider === 'fake' &&
      JSON.stringify(error.details?.flags) === '["--provider-device-type"]',
  );
});

test('every refused field is reported at once', () => {
  assert.throws(
    () =>
      rejectRefusedProviderProfileFields(
        { providerGeoLocation: 'US', providerNoResignApp: true, providerDeviceType: 'virtual' },
        DECLARATION,
      ),
    /--provider-device-type, --provider-geo-location, --provider-no-resign-app are not supported by Fake Cloud\./,
  );
});
