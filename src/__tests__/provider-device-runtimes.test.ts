import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDefaultProviderDeviceRuntimes } from '../provider-device-runtimes.ts';

test('default provider runtimes skip Limrun when only the removed API key alias is configured', async () => {
  const runtimes = await createDefaultProviderDeviceRuntimes({ LIM_API_KEY: 'lim_test_key' });

  assert.equal(
    runtimes.some((runtime) => runtime.provider === 'limrun'),
    false,
  );
  await Promise.all(runtimes.map(async (runtime) => await runtime.shutdown()));
});

test('default provider runtimes load Limrun when a Limrun API key is configured', async () => {
  const runtimes = await createDefaultProviderDeviceRuntimes({ LIMRUN_API_KEY: 'lim_test_key' });

  assert.equal(
    runtimes.some((runtime) => runtime.provider === 'limrun'),
    true,
  );
  await Promise.all(runtimes.map(async (runtime) => await runtime.shutdown()));
});
