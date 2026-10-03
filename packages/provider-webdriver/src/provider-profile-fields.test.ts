import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ProviderProfileField } from '@agent-device/contracts/provider-profile-fields';
import { CLOUD_WEBDRIVER_PROFILE_FIELDS } from './provider-definitions.ts';
import { CLOUD_WEBDRIVER_PROVIDERS } from './providers.ts';
import { BROWSERSTACK_DEVICE_FEATURE_SPECS } from './browserstack-device-features.ts';

// Fields a hub reads directly while building its session, outside the device-feature table.
const HUB_SESSION_FIELDS: readonly ProviderProfileField[] = [
  'providerApp',
  'providerOsVersion',
  'providerProject',
  'providerBuild',
  'providerSessionName',
];

function consumedFields(provider: keyof typeof CLOUD_WEBDRIVER_PROFILE_FIELDS): string[] {
  const { fields } = CLOUD_WEBDRIVER_PROFILE_FIELDS[provider];
  return (Object.keys(fields) as ProviderProfileField[])
    .filter((field) => fields[field] === 'consumed')
    .sort();
}

test('every declaration names the provider it is registered under', () => {
  for (const [provider, declaration] of Object.entries(CLOUD_WEBDRIVER_PROFILE_FIELDS)) {
    assert.equal(declaration.provider, provider);
  }
});

// A consumed device feature with no capability row would be accepted and then dropped at the hub.
test('BrowserStack consumes exactly the fields its capability builder reads', () => {
  assert.deepEqual(
    consumedFields(CLOUD_WEBDRIVER_PROVIDERS.browserStack),
    [...HUB_SESSION_FIELDS, ...BROWSERSTACK_DEVICE_FEATURE_SPECS.map((spec) => spec.field)].sort(),
  );
});

test('AWS Device Farm consumes only its own fields and the session name', () => {
  assert.deepEqual(consumedFields(CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm), [
    'awsAppArn',
    'awsDeviceArn',
    'awsInteractionMode',
    'awsProjectArn',
    'awsRegion',
    'providerSessionName',
  ]);
});
