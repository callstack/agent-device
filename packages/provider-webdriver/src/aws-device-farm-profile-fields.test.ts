import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AWS_DEVICE_FARM_PROFILE_FIELDS } from './aws-device-farm.ts';
import { consumedProfileFields } from './profile-fields.fixtures.ts';

test('AWS Device Farm consumes only its own fields and the session name', () => {
  assert.deepEqual(consumedProfileFields(AWS_DEVICE_FARM_PROFILE_FIELDS), [
    'awsAppArn',
    'awsDeviceArn',
    'awsInteractionMode',
    'awsProjectArn',
    'awsRegion',
    'providerSessionName',
  ]);
});
