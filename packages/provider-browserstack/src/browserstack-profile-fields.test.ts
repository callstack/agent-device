import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ProviderProfileField } from '@agent-device/contracts/provider-profile-fields';
import { BROWSERSTACK_PROFILE_FIELDS } from './profile-fields.ts';
import { BROWSERSTACK_DEVICE_FEATURE_SPECS } from './browserstack-device-features.ts';

// Fields a hub reads directly while building its session, outside the device-feature table.
const HUB_SESSION_FIELDS: readonly ProviderProfileField[] = [
  'providerApp',
  'providerOsVersion',
  'providerProject',
  'providerBuild',
  'providerSessionName',
];

// A consumed device feature with no capability row would be accepted and then dropped at the hub.
test('BrowserStack consumes exactly the fields its capability builder reads', () => {
  assert.deepEqual(
    (Object.keys(BROWSERSTACK_PROFILE_FIELDS.fields) as ProviderProfileField[])
      .filter((field) => BROWSERSTACK_PROFILE_FIELDS.fields[field] === 'consumed')
      .sort(),
    [...HUB_SESSION_FIELDS, ...BROWSERSTACK_DEVICE_FEATURE_SPECS.map((spec) => spec.field)].sort(),
  );
});
