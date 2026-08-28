import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDefaultProviderRuntimeComposition } from '../provider-device-runtimes.ts';

test('default provider runtimes skip Limrun when only the removed API key alias is configured', async () => {
  const { runtimes, platformModules } = await createDefaultProviderRuntimeComposition({
    LIM_API_KEY: 'lim_test_key',
  });

  assert.equal(
    runtimes.some((runtime) => runtime.provider === 'limrun'),
    false,
  );
  assertPlatformModuleCoverage(runtimes, platformModules);
  await Promise.all(runtimes.map(async (runtime) => await runtime.shutdown()));
});

test('default provider runtimes load Limrun when a Limrun API key is configured', async () => {
  const { runtimes, platformModules } = await createDefaultProviderRuntimeComposition({
    LIMRUN_API_KEY: 'lim_test_key',
  });

  assert.equal(
    runtimes.some((runtime) => runtime.provider === 'limrun'),
    true,
  );
  const limrun = runtimes.find((runtime) => runtime.provider === 'limrun');
  assert.equal(limrun ? 'loadRuntime' in limrun : true, false);
  assertPlatformModuleCoverage(runtimes, platformModules, [limrun!]);
  assert.equal(
    platformModules.some(({ runtime }) => runtime === limrun),
    true,
  );
  await Promise.all(runtimes.map(async (runtime) => await runtime.shutdown()));
});

test('default provider runtimes load Doublespeed when a Doublespeed API key is configured', async () => {
  const { runtimes, platformModules } = await createDefaultProviderRuntimeComposition({
    DOUBLESPEED_API_KEY: 'dsx_test_key',
  });

  const doublespeed = runtimes.find((runtime) => runtime.provider === 'doublespeed');
  assert.ok(doublespeed);
  assert.equal(
    runtimes.some((runtime) => runtime.provider === 'limrun'),
    false,
  );
  assertPlatformModuleCoverage(runtimes, platformModules, [doublespeed]);
  assert.equal(
    platformModules.some(({ runtime }) => runtime === doublespeed),
    true,
  );
  await Promise.all(runtimes.map(async (runtime) => await runtime.shutdown()));
});

function assertPlatformModuleCoverage(
  runtimes: readonly object[],
  platformModules: ReadonlyArray<
    Readonly<{ runtime: object; module: { owner: { provider: string } } }>
  >,
  explicitModules: readonly object[] = [],
): void {
  const runtimeModules = runtimes.filter(
    (runtime) => 'owner' in runtime && 'loadRuntime' in runtime,
  );
  assert.deepEqual(
    platformModules.map(({ runtime }) => runtime),
    [...runtimeModules, ...explicitModules],
  );
  for (const { runtime, module } of platformModules) {
    assert.equal('provider' in runtime ? runtime.provider : undefined, module.owner.provider);
  }
}
