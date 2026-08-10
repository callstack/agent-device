import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDefaultProviderRuntimeComposition } from '../provider-device-runtimes.ts';

test('default provider runtimes skip Limrun when only the removed API key alias is configured', async () => {
  const { runtimes, appLogModules } = await createDefaultProviderRuntimeComposition({
    LIM_API_KEY: 'lim_test_key',
  });

  assert.equal(
    runtimes.some((runtime) => runtime.provider === 'limrun'),
    false,
  );
  assert.equal(appLogModules.length, 0);
  await Promise.all(runtimes.map(async (runtime) => await runtime.shutdown()));
});

test('default provider runtimes load Limrun when a Limrun API key is configured', async () => {
  const { runtimes, appLogModules } = await createDefaultProviderRuntimeComposition({
    LIMRUN_API_KEY: 'lim_test_key',
  });

  assert.equal(
    runtimes.some((runtime) => runtime.provider === 'limrun'),
    true,
  );
  const limrun = runtimes.find((runtime) => runtime.provider === 'limrun');
  assert.equal(limrun ? 'loadRuntime' in limrun : true, false);
  assert.equal(appLogModules.length, 1);
  assert.equal(appLogModules[0]?.runtime, limrun);
  await Promise.all(runtimes.map(async (runtime) => await runtime.shutdown()));
});
