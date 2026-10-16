import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { withPluginConnection } from './load.ts';
import {
  pluginHome,
  registrationSource,
  selectPlugin,
  selectV2Plugin,
  v2RegistrationSource,
  webDriverPluginSource,
} from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderPluginHost } from './host.ts';
import type { PluginRegistryPolicy } from './registry.ts';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';

const adaptedDescriptors: string[] = [];
// This package names no provider: the composing root decides how a descriptor becomes a runtime.
const FAKE_POLICY: PluginRegistryPolicy = {
  adaptWebDriver: async (descriptor) => {
    adaptedDescriptors.push(descriptor.provider);
    return {
      runtime: {
        provider: descriptor.provider,
        ownsDevice: () => false,
        getInteractor: () => undefined,
        deviceInventoryProvider: async () => [],
        leaseLifecycle: {},
        shutdown: async () => {},
      } as unknown as ProviderDeviceRuntime,
      platformModule: {
        owner: { kind: 'provider-runtime', provider: descriptor.provider, instance: 'fake' },
        loadRuntime: async () => {
          throw new Error('lazy');
        },
      },
    };
  },
};

async function startStore(env: NodeJS.ProcessEnv, builtin: readonly string[] = ['limrun']) {
  const { claimProviderIds, resolveProviderPlugins, startProviderRegistry } =
    await import('./registry.ts');
  const { storePluginCandidates } = await import('./store.ts');
  const resolved = await resolveProviderPlugins([
    ...claimProviderIds(builtin),
    ...(await storePluginCandidates(env)),
  ]);
  return await startProviderRegistry(resolved, env, FAKE_POLICY);
}

test('a v1 store plugin loads through the adapter with options and the host error constructor', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', 'example', registrationSource('example'));
  const registry = await startStore(env);
  const runtime = registry.registrations[0]!.runtime as ProviderDeviceRuntime & ProviderPluginHost;
  assert.deepEqual(runtime.options, { region: 'eu' });
  assert.ok(runtime.createError('INVALID_ARGS', 'bad profile') instanceof AppError);
  await registry.close();
});

test('a v2 store plugin loads its factory with the selection options', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(home, '@example/v2', v2RegistrationSource('example'));
  const registry = await startStore(env);
  const runtime = registry.registrations[0]!.runtime as ProviderDeviceRuntime & {
    options: unknown;
    hostEnv: Record<string, string | undefined>;
  };
  assert.deepEqual(runtime.options, { region: 'eu' });
  assert.equal(runtime.hostEnv.AGENT_DEVICE_HOME, home);
  assert.deepEqual(registry.inventory, [
    {
      provider: 'example',
      source: 'store',
      package: '@example/v2',
      version: '2.0.0',
      state: 'active',
      credentials: { variables: [], byBackend: {} },
    },
  ]);
  await registry.close();
});

test('v1 and v2 store plugins register in package-name order whichever version they are', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(home, 'b-plugin', v2RegistrationSource('second'));
  selectPlugin(home, 'a-plugin', 'first', registrationSource('first'));
  const registry = await startStore(env);
  assert.deepEqual(
    registry.inventory.map(({ provider, source, package: name }) => [provider, source, name]),
    [
      ['first', 'store', 'a-plugin'],
      ['second', 'store', 'b-plugin'],
    ],
  );
  await registry.close();
});

test('a broken plugin is listed as failed while its working neighbor registers', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(home, 'a-working', v2RegistrationSource('working'));
  selectV2Plugin(home, 'b-throws-on-import', 'throw new Error("import failed");');
  selectV2Plugin(
    home,
    'c-throws-in-factory',
    'export default () => { throw new Error("factory failed"); };',
  );
  selectV2Plugin(
    home,
    'd-invalid',
    `export default () => ({ apiVersion: 2, provider: 'Not Valid', credentials: { variables: [] }, setup() {} });`,
  );
  selectV2Plugin(
    home,
    'e-setup-fails',
    `export default () => ({ apiVersion: 2, provider: 'setup-fails', credentials: { variables: [] }, setup: async () => { throw new Error('setup failed'); } });`,
  );
  selectPlugin(home, 'f-bad-owner', 'bad-owner', registrationSource('other-id'));
  const registry = await startStore(env);

  assert.deepEqual(
    registry.registrations.map(({ provider }) => provider),
    ['working'],
  );
  assert.deepEqual(
    registry.inventory.map(({ package: name, state, error }) => [name, state, error?.reason]),
    [
      ['a-working', 'active', undefined],
      ['b-throws-on-import', 'failed', 'plugin_load_failed'],
      ['c-throws-in-factory', 'failed', 'plugin_load_failed'],
      ['d-invalid', 'failed', 'invalid_plugin'],
      ['e-setup-fails', 'failed', 'plugin_setup_failed'],
      ['f-bad-owner', 'failed', 'invalid_plugin'],
    ],
  );
  assert.match(registry.inventory[1]!.error!.message, /import failed/);
  assert.match(registry.inventory[4]!.error!.message, /setup failed/);
  await registry.close();
});

test('the first plugin to name a provider claims it even when it fails, and later ones are failed', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(
    home,
    'a-claims-then-fails',
    `export default () => ({ apiVersion: 2, provider: 'shared', credentials: { variables: [] }, setup: async () => { throw new Error('setup failed'); } });`,
  );
  selectV2Plugin(home, 'b-duplicate', v2RegistrationSource('shared'));
  selectV2Plugin(home, 'c-builtin-id', v2RegistrationSource('limrun'));
  selectV2Plugin(home, 'd-routing-id', v2RegistrationSource('proxy'));
  const registry = await startStore(env);

  assert.deepEqual(registry.registrations, []);
  assert.deepEqual(
    registry.inventory.map(({ package: name, state, error }) => [name, state, error?.reason]),
    [
      ['a-claims-then-fails', 'failed', 'plugin_setup_failed'],
      ['b-duplicate', 'failed', 'duplicate_provider'],
      ['c-builtin-id', 'failed', 'duplicate_provider'],
      ['d-routing-id', 'failed', 'reserved_provider'],
    ],
  );
  assert.deepEqual(registry.claimedProviders, ['limrun', 'shared']);
  await registry.close();
});

test('a v1 manifest is dispatched before any factory runs and an incompatible one is only listed', async () => {
  const { home, env } = pluginHome();
  const marker = path.join(home, 'evaluated');
  selectPlugin(
    home,
    'one',
    'one',
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'yes');`,
  );
  selectPlugin(home, 'two', 'other', 'throw new Error("evaluated");', 2);
  const { resolveProviderPlugins, claimProviderIds } = await import('./registry.ts');
  const { storePluginCandidates } = await import('./store.ts');
  const resolved = await resolveProviderPlugins([
    ...claimProviderIds(['limrun']),
    ...(await storePluginCandidates(env)),
  ]);

  assert.ok(!fs.existsSync(marker));
  assert.deepEqual(
    resolved.inventory().map(({ package: name, state, error }) => [name, state, error?.reason]),
    [
      ['one', 'active', undefined],
      ['two', 'failed', 'incompatible_plugin'],
    ],
  );
});

test('entry discovery prefers ./agent-device and falls back to the root export only when it is absent', async () => {
  const { home, env } = pluginHome();
  const root = v2RegistrationSource('from-root');
  selectV2Plugin(home, 'a-root-fallback', root, {
    exports: { '.': { import: './plugin.mjs' }, './other': './other.mjs' },
  });
  selectV2Plugin(home, 'b-main-fallback', v2RegistrationSource('from-main'), {
    exports: null,
    manifest: { main: './plugin.mjs' },
  });
  selectV2Plugin(home, 'c-subpath-wins', v2RegistrationSource('from-subpath'), {
    exports: { '.': './root.mjs', './agent-device': './plugin.mjs' },
    files: { 'root.mjs': 'throw new Error("root must not load");' },
  });
  selectV2Plugin(home, 'd-subpath-broken', 'throw new Error("subpath import failed");', {
    exports: { '.': './root.mjs', './agent-device': './plugin.mjs' },
    files: { 'root.mjs': v2RegistrationSource('from-root-after-failure') },
  });
  selectV2Plugin(home, 'e-subpath-condition-missing', root, {
    exports: { '.': './plugin.mjs', './agent-device': { require: './plugin.mjs' } },
  });
  const registry = await startStore(env);

  assert.deepEqual(
    registry.inventory.map(({ package: name, provider, state }) => [name, provider, state]),
    [
      ['a-root-fallback', 'from-root', 'active'],
      ['b-main-fallback', 'from-main', 'active'],
      ['c-subpath-wins', 'from-subpath', 'active'],
      ['d-subpath-broken', undefined, 'failed'],
      ['e-subpath-condition-missing', undefined, 'failed'],
    ],
  );
  await registry.close();
});

test('startup failure of one plugin cleans up its constructed runtime and keeps the others', async () => {
  for (const instance of ["'test'", 'undefined', '42', '" "']) {
    const { home, env } = pluginHome();
    const first = path.join(home, 'first-shutdown');
    const invalid = path.join(home, 'invalid-shutdown');
    selectPlugin(home, 'one', 'one', registrationSource('one', first));
    const source = registrationSource(instance === "'test'" ? 'wrong' : 'two', invalid).replace(
      "instance: 'test'",
      `instance: ${instance}`,
    );
    selectPlugin(home, 'two', 'two', source);
    const registry = await startStore(env);
    assert.deepEqual(
      registry.registrations.map(({ provider }) => provider),
      ['one'],
    );
    assert.equal(registry.inventory[1]!.state, 'failed');
    assert.ok(fs.existsSync(invalid));
    assert.ok(!fs.existsSync(first));
    await registry.close();
    assert.ok(fs.existsSync(first));
  }
});

test('a plugin dispose runs after its runtime shuts down', async () => {
  const { home, env } = pluginHome();
  const log = path.join(home, 'order');
  selectV2Plugin(
    home,
    'disposing',
    `import fs from 'node:fs';
    export default (options) => ({
      apiVersion: 2, provider: 'disposing', credentials: { variables: [] },
      setup: async () => ({
        runtime: { provider: 'disposing', ownsDevice: () => false, getInteractor: () => undefined,
          deviceInventoryProvider: async () => [], leaseLifecycle: {},
          shutdown: async () => { fs.appendFileSync(options.log, 'runtime;'); } },
        platformModule: { owner: { kind: 'provider-runtime', provider: 'disposing', instance: 'test' }, loadRuntime: async () => { throw new Error('lazy'); } },
        dispose: async () => { fs.appendFileSync(options.log, 'dispose;'); },
      }),
    });`,
    { selectionOptions: { log } },
  );
  const registry = await startStore(env);
  await registry.close();
  await registry.close();
  assert.equal(fs.readFileSync(log, 'utf8'), 'runtime;dispose;');
});

test('a frozen runtime registers untouched, serves its facets, and is shut down and disposed once', async () => {
  const { home, env } = pluginHome();
  const log = path.join(home, 'frozen');
  selectV2Plugin(
    home,
    'frozen',
    `import fs from 'node:fs';
    export default (options) => ({
      apiVersion: 2, provider: 'frozen', credentials: { variables: [] },
      setup: async () => ({
        runtime: Object.freeze({ provider: 'frozen', ownsDevice: () => false, getInteractor: () => undefined,
          deviceInventoryProvider: async () => [], leaseLifecycle: Object.freeze({}),
          shutdown: async () => { fs.appendFileSync(options.log, 'runtime;'); } }),
        platformModule: Object.freeze({ owner: Object.freeze({ kind: 'provider-runtime', provider: 'frozen', instance: 'test' }), loadRuntime: async () => { throw new Error('lazy'); } }),
        dispose: async () => { fs.appendFileSync(options.log, 'dispose;'); },
      }),
    });`,
    { selectionOptions: { log } },
  );
  const registry = await startStore(env);
  const { runtime } = registry.registrations[0]!;
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(runtime.ownsDevice({} as never), false);
  await registry.close();
  await registry.close();
  assert.equal(fs.readFileSync(log, 'utf8'), 'runtime;dispose;');
});

test('connection callbacks run from a v1 plugin and always release its runtime', async () => {
  const { home, env } = pluginHome();
  const marker = path.join(home, 'shutdown');
  const source = registrationSource('example', marker).replace(
    'platformModule:',
    "connection: { resolve: () => ({ profile: { leaseProvider: 'example', platform: 'android' } }), verify: async () => { throw host.createError('COMMAND_FAILED', 'verification failed'); } }, platformModule:",
  );
  selectPlugin(home, 'example', 'example', source);
  selectPlugin(home, 'unrelated', 'unrelated', 'throw new Error("unrelated plugin evaluated");');
  const manifestPath = path.join(
    home,
    'plugins',
    JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).plugins.example
      .installation,
    'node_modules/example/package.json',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.agentDevicePlugin.connection = LOCAL_CONNECTION;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const flags = { json: false, help: false, version: false };

  const profile = await withPluginConnection(
    'example',
    ['limrun'],
    env,
    async (connection) => await connection.resolve({ flags, stateDir: home, cwd: home, env }),
  );
  assert.equal(profile.profile.platform, 'android');
  assert.ok(fs.existsSync(marker));
  fs.unlinkSync(marker);
  await assert.rejects(
    withPluginConnection(
      'example',
      ['limrun'],
      env,
      async (connection) => await connection.verify({ flags, env }),
    ),
    { code: 'COMMAND_FAILED' },
  );
  assert.ok(fs.existsSync(marker));
});

test('a v2 plugin connection runs without setting up any runtime', async () => {
  const { home, env } = pluginHome();
  const marker = path.join(home, 'setup-ran');
  selectV2Plugin(
    home,
    'example',
    v2RegistrationSource('example', {
      extra: `connection: {
        capabilities: ${JSON.stringify(LOCAL_CONNECTION)},
        resolve: ({ host }) => ({ profile: { leaseProvider: 'example', platform: 'ios', device: host.env.AGENT_DEVICE_HOME + ':' + (typeof host.createError) } }),
        verify: async () => { throw new Error('verify failed'); },
      },`,
    }).replace(
      'setup: async host => (',
      "setup: async host => (fs.writeFileSync(options.marker, 'x'), ",
    ),
    { selectionOptions: { marker } },
  );
  const flags = { json: false, help: false, version: false };

  const resolved = await withPluginConnection(
    'example',
    ['limrun'],
    env,
    async (connection) => await connection.resolve({ flags, stateDir: home, cwd: home, env }),
  );
  assert.equal(resolved.profile.platform, 'ios');
  assert.equal(resolved.profile.device, `${home}:function`);
  assert.ok(!fs.existsSync(marker));
  await assert.rejects(
    withPluginConnection('missing', ['limrun'], env, async () => undefined),
    { code: 'INVALID_ARGS' },
  );
});

const LOCAL_CONNECTION = {
  leaseKind: 'direct-device-provider',
  requiresAppAttachment: false,
  requiresRemoteDaemon: false,
  supportsArtifacts: false,
  supportsDeferredAppSelection: true,
  supportsDirectPortReverse: false,
  usesCloudWebDriverLease: false,
};

test('a WebDriver descriptor is adapted by the policy, and a mismatched provider never reaches it', async () => {
  const { home, env } = pluginHome();
  const source = webDriverPluginSource('example');
  selectPlugin(home, 'example', 'example', source);
  const registry = await startStore(env, []);
  assert.deepEqual(
    registry.registrations.map(({ provider, runtime }) => [provider, runtime.provider]),
    [['example', 'example']],
  );
  assert.deepEqual(adaptedDescriptors, ['example']);
  await registry.close();

  adaptedDescriptors.length = 0;
  const other = pluginHome();
  selectPlugin(other.home, 'example', 'wrong', source);
  const mismatched = await startStore(other.env, []);
  assert.deepEqual(mismatched.registrations, []);
  assert.equal(mismatched.inventory[0]!.error?.reason, 'invalid_plugin');
  assert.deepEqual(adaptedDescriptors, []);
});

test('a factory returning a primitive is listed as an invalid plugin', async () => {
  for (const value of ['42', '"runtime"', 'true']) {
    const { home, env } = pluginHome();
    selectPlugin(home, 'example', 'example', `export default () => ${value};`);
    const registry = await startStore(env, []);
    assert.deepEqual(registry.registrations, []);
    assert.equal(registry.inventory[0]!.state, 'failed');
    assert.equal(registry.inventory[0]!.error?.reason, 'invalid_plugin');
  }
});

test('a damaged config is isolated as one failed store entry', async () => {
  const { home, env } = pluginHome();
  fs.writeFileSync(path.join(home, 'config.json'), '{ not json');
  const registry = await startStore(env);
  assert.deepEqual(registry.registrations, []);
  assert.equal(registry.inventory.length, 1);
  assert.equal(registry.inventory[0]!.source, 'store');
  assert.equal(registry.inventory[0]!.state, 'failed');
});

test('a package with a plain main and no exports loads, and main is ignored once exports exist', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(home, 'a-plain-main', v2RegistrationSource('plain-main'), {
    exports: null,
    manifest: { main: 'plugin.mjs' },
  });
  selectV2Plugin(home, 'b-exports-without-root', v2RegistrationSource('ignored-main'), {
    exports: { './other': './plugin.mjs' },
    manifest: { main: './plugin.mjs' },
  });
  const registry = await startStore(env);
  assert.deepEqual(
    registry.inventory.map(({ package: name, provider, state }) => [name, provider, state]),
    [
      ['a-plain-main', 'plain-main', 'active'],
      ['b-exports-without-root', undefined, 'failed'],
    ],
  );
  await registry.close();
});

test('a selection whose installation is not a string is isolated as one failed entry', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(home, 'b-working', v2RegistrationSource('working'));
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  config.plugins['a-damaged'] = { installation: 5 };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  const registry = await startStore(env);
  assert.deepEqual(
    registry.inventory.map(({ package: name, state }) => [name, state]),
    [
      ['a-damaged', 'failed'],
      ['b-working', 'active'],
    ],
  );
  await registry.close();
});

test('a plugin whose byBackend lists an undefined value is listed as invalid', async () => {
  const { home, env } = pluginHome();
  selectV2Plugin(
    home,
    'a-undefined-backend',
    v2RegistrationSource('undefined-backend', {
      credentials: '{ variables: [], byBackend: { ios: undefined } }',
    }),
  );
  const registry = await startStore(env);
  assert.equal(registry.inventory[0]!.state, 'failed');
  assert.equal(registry.inventory[0]!.error?.reason, 'invalid_plugin');
  await registry.close();
});

test('a rejected setup shuts its runtime down before it disposes', async () => {
  const { home, env } = pluginHome();
  const log = path.join(home, 'order');
  selectV2Plugin(
    home,
    'rejected',
    `import fs from 'node:fs';
    export default (options) => ({
      apiVersion: 2, provider: 'rejected', credentials: { variables: [] },
      setup: async () => ({
        runtime: { provider: 'other-id', shutdown: async () => { fs.appendFileSync(options.log, 'runtime;'); } },
        platformModule: {},
        dispose: async () => { fs.appendFileSync(options.log, 'dispose;'); },
      }),
    });`,
    { selectionOptions: { log } },
  );
  const registry = await startStore(env);
  assert.equal(registry.inventory[0]!.state, 'failed');
  assert.equal(fs.readFileSync(log, 'utf8'), 'runtime;dispose;');
});

test('a typed error without a reason gets the stage reason, and one with a reason keeps it', async () => {
  const { resolveProviderPlugins } = await import('./registry.ts');
  const resolved = await resolveProviderPlugins([
    {
      source: 'embedder',
      package: 'no-reason',
      load: () => {
        throw new AppError('INVALID_ARGS', 'bad options', { hint: 'fix them' });
      },
    },
    {
      source: 'embedder',
      package: 'with-reason',
      load: () => {
        throw new AppError('INVALID_ARGS', 'bad plugin', { reason: 'invalid_plugin' });
      },
    },
  ]);
  assert.equal(resolved.inventory()[0]!.error?.hint, 'fix them');
  assert.deepEqual(
    resolved.inventory().map(({ error }) => [error?.code, error?.reason]),
    [
      ['INVALID_ARGS', 'plugin_load_failed'],
      ['INVALID_ARGS', 'invalid_plugin'],
    ],
  );
});

test('connect reuses the primed store instead of running every factory again', async () => {
  const { home, env } = pluginHome();
  const log = path.join(home, 'factory-calls');
  selectV2Plugin(
    home,
    'counted',
    v2RegistrationSource('counted', {
      extra: `connection: {
        capabilities: ${JSON.stringify(LOCAL_CONNECTION)},
        resolve: () => ({ profile: { leaseProvider: 'counted', platform: 'ios' } }),
        verify: async () => { throw new Error('unused'); },
      },`,
    }).replace(
      'export default (options = {}) => ({',
      "export default (options = {}) => (fs.appendFileSync(options.log, 'x'), {",
    ),
    { selectionOptions: { log } },
  );
  const { primePluginConnections } = await import('./connection.ts');
  const flags = { json: false, help: false, version: false };
  const connect = async (provider: string) =>
    await withPluginConnection(
      provider,
      ['limrun'],
      env,
      async (connection) => await connection.resolve({ flags, stateDir: home, cwd: home, env }),
    );

  await primePluginConnections(env, ['limrun']);
  await connect('counted');
  await connect('counted');
  assert.equal(fs.readFileSync(log, 'utf8'), 'x');
  await assert.rejects(connect('limrun'), { code: 'INVALID_ARGS' });
  assert.equal(fs.readFileSync(log, 'utf8'), 'x'.repeat(2));
});

test('one plugin failing to shut down does not stop the others from shutting down and disposing', async () => {
  const { home, env } = pluginHome();
  const log = path.join(home, 'close-log');
  const source = (name: string, shutdownBody: string) => `import fs from 'node:fs';
    export default (options) => ({
      apiVersion: 2, provider: ${JSON.stringify(name)}, credentials: { variables: [] },
      setup: async () => ({
        runtime: { provider: ${JSON.stringify(name)}, ownsDevice: () => false, getInteractor: () => undefined,
          deviceInventoryProvider: async () => [], leaseLifecycle: {},
          shutdown: async () => { ${shutdownBody} } },
        platformModule: { owner: { kind: 'provider-runtime', provider: ${JSON.stringify(name)}, instance: 'test' }, loadRuntime: async () => { throw new Error('lazy'); } },
        dispose: async () => { fs.appendFileSync(options.log, ${JSON.stringify(`${name}-dispose;`)}); },
      }),
    });`;
  selectV2Plugin(
    home,
    'a-throws',
    source(
      'throws',
      "fs.appendFileSync(options.log, 'throws-shutdown;'); throw new Error('boom');",
    ),
    { selectionOptions: { log } },
  );
  selectV2Plugin(
    home,
    'b-fine',
    source('fine', "fs.appendFileSync(options.log, 'fine-shutdown;');"),
    { selectionOptions: { log } },
  );
  const registry = await startStore(env);
  assert.equal(registry.registrations.length, 2);

  const outcomes = await registry.close();

  const events = fs.readFileSync(log, 'utf8').split(';').filter(Boolean).sort();
  assert.deepEqual(events, ['fine-dispose', 'fine-shutdown', 'throws-dispose', 'throws-shutdown']);
  assert.deepEqual(
    outcomes.map(({ provider, source, shutdown, dispose }) => [
      provider,
      source,
      shutdown.status === 'failed' ? shutdown.error.message : shutdown.status,
      dispose.status,
    ]),
    [
      ['throws', 'store', 'boom', 'ok'],
      ['fine', 'store', 'ok', 'ok'],
    ],
  );
  assert.equal(await registry.close(), outcomes);
});
