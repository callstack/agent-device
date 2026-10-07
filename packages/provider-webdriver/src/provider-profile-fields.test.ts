import { test } from 'vitest';
import assert from 'node:assert/strict';
import type {
  ProviderProfileField,
  ProviderProfileFieldDeclaration,
} from '@agent-device/contracts/provider-profile-fields';
import { AWS_DEVICE_FARM_PROFILE_FIELDS } from './aws-device-farm.ts';
import { BROWSERSTACK_PROFILE_FIELDS } from './browserstack.ts';
import { BUNDLED_CLOUD_WEBDRIVER_PROVIDERS } from './index.ts';
import { BROWSERSTACK_DEVICE_FEATURE_SPECS } from './browserstack-device-features.ts';

// Fields a hub reads directly while building its session, outside the device-feature table.
const HUB_SESSION_FIELDS: readonly ProviderProfileField[] = [
  'providerApp',
  'providerOsVersion',
  'providerProject',
  'providerBuild',
  'providerSessionName',
];

function consumedFields({ fields }: ProviderProfileFieldDeclaration): string[] {
  return (Object.keys(fields) as ProviderProfileField[])
    .filter((field) => fields[field] === 'consumed')
    .sort();
}

test('every bundled runtime reads the profile fields declared under its provider id', () => {
  const host = {
    env: {},
    clientVersion: 'test',
    runHostCommand: async () => {
      throw new Error('declarations need no host command');
    },
  };
  for (const bundled of BUNDLED_CLOUD_WEBDRIVER_PROVIDERS) {
    const { webDriver } = bundled.create(host);
    assert.equal(webDriver.provider, bundled.declaration.provider);
    assert.equal(webDriver.profileFields.provider, bundled.declaration.provider);
  }
});

// A consumed device feature with no capability row would be accepted and then dropped at the hub.
test('BrowserStack consumes exactly the fields its capability builder reads', () => {
  assert.deepEqual(
    consumedFields(BROWSERSTACK_PROFILE_FIELDS),
    [...HUB_SESSION_FIELDS, ...BROWSERSTACK_DEVICE_FEATURE_SPECS.map((spec) => spec.field)].sort(),
  );
});

test('AWS Device Farm consumes only its own fields and the session name', () => {
  assert.deepEqual(consumedFields(AWS_DEVICE_FARM_PROFILE_FIELDS), [
    'awsAppArn',
    'awsDeviceArn',
    'awsInteractionMode',
    'awsProjectArn',
    'awsRegion',
    'providerSessionName',
  ]);
});
