import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createDefaultProviderRuntimeComposition,
  createDaemonProviderRuntimeComposition,
} from '../provider-device-runtimes.ts';
import { pluginHome, selectPlugin, registrationSource } from '../plugins/plugin.fixtures.ts';

test('daemon composition registers installed provider runtimes and their lazy platform modules', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', 'example', registrationSource('example'));
  const composition = await createDaemonProviderRuntimeComposition(env);
  const plugin = composition.runtimes.find((runtime) => runtime.provider === 'example');
  assert.ok(plugin);
  assert.equal(
    composition.platformModules.find(({ runtime }) => runtime === plugin)?.module.owner.provider,
    'example',
  );
  await Promise.all(composition.runtimes.map((runtime) => runtime.shutdown()));
});

test('bundled composition stays independent of configured plugins and reserves all builtin IDs', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', 'example', 'throw new Error("must not evaluate");');
  const composition = await createDefaultProviderRuntimeComposition(env);
  assert.ok(composition.runtimes.every(({ provider }) => provider !== 'example'));
  await Promise.all(composition.runtimes.map((runtime) => runtime.shutdown()));
});

test('daemon composition rejects builtin provider IDs before evaluating plugins', async () => {
  for (const provider of ['limrun', 'browserstack', 'aws-device-farm']) {
    const { home, env } = pluginHome();
    selectPlugin(home, 'example', provider, 'throw new Error("must not evaluate");');
    await assert.rejects(createDaemonProviderRuntimeComposition(env), { code: 'INVALID_ARGS' });
  }
});

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
