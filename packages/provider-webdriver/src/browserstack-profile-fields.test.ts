import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ProviderProfileField } from '@agent-device/contracts/provider-profile-fields';
import { BROWSERSTACK_PROFILE_FIELDS } from './browserstack.ts';
import { BROWSERSTACK_DEVICE_FEATURE_SPECS } from './browserstack-device-features.ts';
import { consumedProfileFields } from './profile-fields.fixtures.ts';

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
    consumedProfileFields(BROWSERSTACK_PROFILE_FIELDS),
    [...HUB_SESSION_FIELDS, ...BROWSERSTACK_DEVICE_FEATURE_SPECS.map((spec) => spec.field)].sort(),
  );
});
