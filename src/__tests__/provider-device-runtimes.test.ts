import { createPlatformPluginHost } from '../platform-runtime/plugin-host.ts';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createDaemonProviderRuntimeComposition as composeDaemonProviders,
  createEmbeddedProviderRuntimeComposition,
} from '../provider-device-runtimes.ts';
import { limrunPluginCandidate } from './test-utils/limrun-plugin-store.ts';
import fs from 'node:fs';
import path from 'node:path';
import { pluginHome, selectPlugin, pluginSource } from '@agent-device/test-kit';

function createDaemonProviderRuntimeComposition(
  host: Parameters<typeof composeDaemonProviders>[0],
) {
  return composeDaemonProviders(host, createPlatformPluginHost(host, host.cwd));
}

/** The daemon's composition with the Limrun plugin installed, without an on-disk store. */
function composeWithLimrunInstalled(env: Record<string, string | undefined>) {
  const host = { env, cwd: process.cwd() };
  return createEmbeddedProviderRuntimeComposition(
    host,
    [limrunPluginCandidate()],
    createPlatformPluginHost(host, host.cwd),
  );
}

test('daemon composition registers installed provider runtimes and their lazy platform modules', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', pluginSource('example'));
  const composition = await createDaemonProviderRuntimeComposition({
    env: env,
    cwd: process.cwd(),
  });
  const plugin = composition.runtimes.find((runtime) => runtime.provider === 'example');
  assert.ok(plugin);
  assert.equal(
    composition.platformModules.find(({ runtime }) => runtime === plugin)?.module.owner.provider,
    'example',
  );
  await composition.shutdown();
});

test('core registers no Limrun provider of its own beside the store provider', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', pluginSource('example'));
  const composition = await createDaemonProviderRuntimeComposition({
    env: env,
    cwd: process.cwd(),
  });

  assert.deepEqual(
    composition.runtimes.map((runtime) => runtime.provider),
    ['example'],
  );
  assert.deepEqual(
    composition.inventory.map(({ provider, source, state }) => [provider, source, state]),
    [['example', 'store', 'active']],
  );
  await composition.shutdown();
});

test('an installed Limrun is recorded as failed for a partial instance set', async () => {
  const composition = await composeWithLimrunInstalled({
    ...pluginHome().env,
    LIMRUN_API_KEY: 'lim_test_key',
    LIM_ANDROID_INSTANCE_URL: 'https://region.limrun.example/v1/android_x/api',
    LIM_ANDROID_INSTANCE_TOKEN: 'android-instance-token',
  });

  assert.deepEqual(composition.runtimes, []);
  const limrun = composition.inventory.find(({ provider }) => provider === 'limrun');
  assert.equal(limrun?.state, 'failed');
  assert.equal(limrun?.error?.code, 'INVALID_ARGS');
  assert.match(limrun?.error?.message ?? '', /LIM_ANDROID_INSTANCE_ADB_URL/);
  await composition.shutdown();
});

test('BrowserStack registers as an ordinary store plugin, not a built-in', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, '@agent-device/browserstack', pluginSource('browserstack'));
  const composition = await createDaemonProviderRuntimeComposition({
    env: env,
    cwd: process.cwd(),
  });

  assert.deepEqual(
    composition.inventory
      .filter(({ provider }) => provider === 'browserstack')
      .map(({ provider, source, state, package: name }) => [provider, source, state, name]),
    [['browserstack', 'store', 'active', '@agent-device/browserstack']],
  );
  await composition.shutdown();
});

test('AWS Device Farm registers as an ordinary store plugin, not a built-in', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, '@agent-device/aws-device-farm', pluginSource('aws-device-farm'));
  const composition = await createDaemonProviderRuntimeComposition({
    env: env,
    cwd: process.cwd(),
  });

  assert.deepEqual(
    composition.inventory
      .filter(({ provider }) => provider === 'aws-device-farm')
      .map(({ provider, source, state, package: name }) => [provider, source, state, name]),
    [['aws-device-farm', 'store', 'active', '@agent-device/aws-device-farm']],
  );
  await composition.shutdown();
});

test('a plugin claiming a routing identity is refused before the registry settles claims', async () => {
  for (const provider of ['cloud', 'proxy']) {
    const { home, env } = pluginHome();
    selectPlugin(home, 'example', pluginSource(provider));
    const composition = await createDaemonProviderRuntimeComposition({
      env: env,
      cwd: process.cwd(),
    });
    const plugin = composition.inventory.find(({ package: name }) => name === 'example');
    assert.equal(plugin?.state, 'failed');
    assert.equal(plugin?.error?.reason, 'reserved_provider');
    await composition.shutdown();
  }
});

test('an installed Limrun names the credentials it needs when only the removed API key alias is configured', async () => {
  const { runtimes, platformModules, inventory, shutdown } = await composeWithLimrunInstalled({
    ...pluginHome().env,
    LIM_API_KEY: 'lim_test_key',
  });

  assert.equal(
    runtimes.some((runtime) => runtime.provider === 'limrun'),
    false,
  );
  const limrun = inventory.find(({ provider }) => provider === 'limrun');
  assert.equal(limrun?.state, 'failed');
  assert.equal(limrun?.error?.reason, 'missing_provider_credentials');
  assertPlatformModuleCoverage(runtimes, platformModules);
  await shutdown();
});

test('an installed Limrun registers when a Limrun API key is configured', async () => {
  const { runtimes, platformModules, inventory, shutdown } = await composeWithLimrunInstalled({
    ...pluginHome().env,
    LIMRUN_API_KEY: 'lim_test_key',
  });

  const limrun = runtimes.find((runtime) => runtime.provider === 'limrun');
  assert.ok(limrun);
  assert.equal('loadRuntime' in limrun, false);
  assert.deepEqual(
    inventory
      .filter(({ provider }) => provider === 'limrun')
      .map(({ source, state, package: name }) => [source, state, name]),
    [['store', 'active', '@agent-device/limrun']],
  );
  assertPlatformModuleCoverage(runtimes, platformModules, [limrun]);
  await shutdown();
});

test('an installed Limrun registers for an existing instance without an API key', async () => {
  const { runtimes, platformModules, shutdown } = await composeWithLimrunInstalled({
    ...pluginHome().env,
    LIM_IOS_INSTANCE_URL: 'https://region.limrun.example/v1/ios_x/api',
    LIM_IOS_INSTANCE_TOKEN: 'ios-instance-token',
  });

  const limrun = runtimes.find((runtime) => runtime.provider === 'limrun');
  assert.ok(limrun);
  assertPlatformModuleCoverage(runtimes, platformModules, [limrun]);
  await shutdown();
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

test('composition shutdown is the only route the daemon uses: it shuts every runtime down and runs plugin cleanup', async () => {
  const { home, env } = pluginHome();
  const log = path.join(home, 'shutdown-log');
  selectPlugin(
    home,
    'cleaning',
    `import fs from 'node:fs';
    export default (options) => ({
      apiVersion: 3, contributes: [{ kind: 'provider', provider: "cleaning", credentials: { variables: [] },
      setup: async () => ({
        runtime: { provider: "cleaning", ownsDevice: () => false, getInteractor: () => undefined,
          deviceInventoryProvider: async () => [], leaseLifecycle: {},
          shutdown: async () => { fs.appendFileSync(options.log, 'runtime;'); } },
        platformModule: { owner: { kind: 'provider-runtime', provider: "cleaning", instance: 'test' }, loadRuntime: async () => { throw new Error('lazy'); } },
        dispose: async () => { fs.appendFileSync(options.log, 'dispose;'); },
      }),
      }],
    });`,
    { selectionOptions: { log } },
  );
  const composition = await createDaemonProviderRuntimeComposition({
    env: env,
    cwd: process.cwd(),
  });
  assert.ok(composition.runtimes.some((runtime) => runtime.provider === 'cleaning'));

  await composition.shutdown();

  assert.equal(fs.readFileSync(log, 'utf8'), 'runtime;dispose;');
});
