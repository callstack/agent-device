import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { runCliCapture } from './cli-capture.ts';

vi.mock('@agent-device/plugins/store', async (importOriginal) =>
  (await import('./test-utils/limrun-plugin-store.ts')).storeWithLimrunInstalled(
    importOriginal as () => Promise<typeof import('@agent-device/plugins/store')>,
  ),
);

test('connect limrun refuses profile fields Limrun does not read', async () => {
  const result = await runCliCapture(
    [
      'connect',
      'limrun',
      '--session',
      'ci',
      '--platform',
      'ios',
      '--provider-os-version',
      '18',
      '--provider-geo-location',
      'US',
      '--json',
    ],
    {
      env: { LIMRUN_API_KEY: 'lim_test_key' },
      stateDirPrefix: 'agent-device-connect-limrun-profile-fields-',
    },
  );
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'INVALID_ARGS');
  assert.deepEqual(payload.error.details.flags, [
    '--provider-os-version',
    '--provider-geo-location',
  ]);
});

test('connect limrun applies the same refusal when attaching to an existing instance', async () => {
  // An attached instance is the other way in, so the same refusal has to answer there too, before
  // any connection profile is written.
  const result = await runCliCapture(
    [
      'connect',
      'limrun',
      '--session',
      'ci',
      '--platform',
      'ios',
      '--provider-os-version',
      '18.0',
      '--json',
    ],
    {
      env: {
        LIMRUN_API_KEY: '',
        LIM_IOS_INSTANCE_URL: 'https://region.limrun.example/v1/ios_x/api',
        LIM_IOS_INSTANCE_TOKEN: 'ios-instance-token',
      },
      stateDirPrefix: 'agent-device-connect-limrun-attach-profile-fields-',
    },
  );
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'INVALID_ARGS');
  assert.deepEqual(payload.error.details.flags, ['--provider-os-version']);
});

test('connect limrun refuses the device type before saving a profile', async () => {
  const result = await runCliCapture(
    [
      'connect',
      'limrun',
      '--session',
      'ci',
      '--platform',
      'ios',
      '--provider-device-type',
      'real',
      '--json',
    ],
    {
      env: { LIMRUN_API_KEY: 'lim_test_key' },
      stateDirPrefix: 'agent-device-connect-limrun-device-type-',
    },
  );
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'INVALID_ARGS');
  assert.match(payload.error.message, /^--provider-device-type is not supported by Limrun/);
  assert.equal(payload.error.details.provider, 'limrun');
});
