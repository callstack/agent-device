import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ProviderProfileField } from '@agent-device/contracts/provider-profile-fields';
import { AWS_DEVICE_FARM_PROFILE_FIELDS } from './profile-fields.ts';

test('AWS Device Farm consumes only its own fields and the session name', () => {
  assert.deepEqual(
    (Object.keys(AWS_DEVICE_FARM_PROFILE_FIELDS.fields) as ProviderProfileField[])
      .filter((field) => AWS_DEVICE_FARM_PROFILE_FIELDS.fields[field] === 'consumed')
      .sort(),
    [
      'awsAppArn',
      'awsDeviceArn',
      'awsInteractionMode',
      'awsProjectArn',
      'awsRegion',
      'providerSessionName',
    ],
  );
});
