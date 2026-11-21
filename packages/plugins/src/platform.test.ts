import { expect, test } from 'vitest';
import { pluginHome, selectPlugin } from '@agent-device/test-kit';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { storePluginCandidates } from './store.ts';
import { resolveProviderPlugins, startProviderRegistry } from './registry.ts';

const WEB_PACKAGE = '@agent-device/web';
const stateDir = '/fixture-state';
const platformClaim = `{
  kind: 'platform',
  family: 'web',
  setup: host => ({
    family: 'web',
    inventoryModule: { family: 'web', loadInventory: async () => ({
      discover: async () => [{ id: host.stateDir, platform: 'web', kind: 'device' }],
    }) },
    runtimeModule: { family: 'web', loadRuntime() { throw new Error('must stay lazy'); } },
    createInteractor() { throw new Error('must stay lazy'); },
    withRequestProvider: async (_, task) => task(),
    operations: {
      setup() {},
      doctor() {},
      cleanupOrphans() { throw new Error('startup operation is not a disposer'); },
      browserLifecycleCheck() {},
      createProvider() {},
      resolveRequestProvider() {},
    },
  }),
}`;

function selectWeb(home: string, opts: Parameters<typeof selectPlugin>[3] = {}) {
  selectPlugin(
    home,
    WEB_PACKAGE,
    `export default () => ({ apiVersion: 3, contributes: [${platformClaim}] });`,
    { claims: { apiVersion: 3, platform: 'web' }, ...opts },
  );
}

async function startStore(env: HostEnvironment['env']) {
  const candidates = await storePluginCandidates(env);
  const host = { env, cwd: '/' };
  const resolved = await resolveProviderPlugins(candidates);
  return await startProviderRegistry(resolved, host, {
    platformHost: {
      ...host,
      stateDir,
      runCommand: async () => {
        throw new Error('setup must not start a process');
      },
      isFileExecutable: async () => false,
      isExecutableOnPath: async () => false,
      listHostProcesses: async () => [],
      emitDiagnostic: () => {},
      withDiagnosticTimer: async (_phase, run) => await run(),
    },
    adaptWebDriver: async () => {
      throw new Error('unexpected WebDriver');
    },
  });
}

test('a managed platform registers its inventory against the supplied state directory and closes once', async () => {
  const { home, env } = pluginHome();
  selectWeb(home);
  const registry = await startStore(env);
  expect(registry.inventory).toEqual([
    {
      source: 'store',
      package: WEB_PACKAGE,
      version: '2.0.0',
      platform: 'web',
      state: 'active',
      credentials: { variables: [], byBackend: {} },
    },
  ]);
  const [platform] = registry.platforms;
  if (platform?.family !== 'web') throw new Error('expected web');
  const inventory = await platform.inventoryModule.loadInventory();
  expect(
    await inventory.discover(
      {},
      {
        signal: new AbortController().signal,
        diagnostics: { emit() {} },
        progress: { report() {} },
      },
    ),
  ).toEqual([{ id: stateDir, platform: 'web', kind: 'device' }]);
  const closing = registry.close();
  expect(registry.close()).toBe(closing);
  await expect(closing).resolves.toEqual([
    { platform: 'web', source: 'store', shutdown: { status: 'ok' }, dispose: { status: 'ok' } },
  ]);
});

test.each([
  ['unknown family', 'example', platformClaim, 'invalid_plugin'],
  ['factory mismatch', 'linux', platformClaim, 'invalid_plugin'],
  [
    'wrong runtime family',
    'web',
    platformClaim.replace("runtimeModule: { family: 'web'", "runtimeModule: { family: 'linux'"),
    'invalid_plugin',
  ],
  ['missing operation', 'web', platformClaim.replace('doctor() {},', ''), 'invalid_plugin'],
])('rejects a platform claim with %s', async (_description, family, claim, reason) => {
  const { home, env } = pluginHome();
  selectPlugin(
    home,
    WEB_PACKAGE,
    `export default () => ({ apiVersion: 3, contributes: [${claim}] });`,
    {
      claims: { apiVersion: 3, platform: family },
    },
  );
  const registry = await startStore(env);
  expect(registry.platforms).toEqual([]);
  expect(registry.inventory).toMatchObject([{ state: 'failed', error: { reason } }]);
  await registry.close();
});

test('a below-floor package retains its platform claim without importing its entry', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, WEB_PACKAGE, "throw new Error('must never import');", {
    claims: { apiVersion: 3, platform: 'web' },
    manifest: { engines: { node: '>=999' } },
  });
  selectPlugin(
    home,
    'later-plugin',
    `export default () => ({ apiVersion: 3, contributes: [${platformClaim}] });`,
    {
      claims: { apiVersion: 3, platform: 'web' },
    },
  );
  const registry = await startStore(env);
  expect(registry.inventory).toMatchObject([
    { platform: 'web', state: 'failed', error: { reason: 'node-below-floor' } },
    { platform: 'web', state: 'failed', error: { reason: 'duplicate_platform' } },
  ]);
  await registry.close();
});

test('platform and replay claims in one package activate independently', async () => {
  const { home, env } = pluginHome();
  selectPlugin(
    home,
    WEB_PACKAGE,
    `export default () => ({
    apiVersion: 3,
    contributes: [${platformClaim}, {
      kind: 'replay-backend',
      backend: 'fixture',
      setup() { throw new Error('replay setup failed'); },
    }],
  });`,
    { claims: { apiVersion: 3, platform: 'web', replayBackend: 'fixture' } },
  );
  const registry = await startStore(env);
  expect(registry.inventory).toMatchObject([
    { platform: 'web', state: 'active' },
    { backend: 'fixture', state: 'failed', error: { reason: 'plugin_setup_failed' } },
  ]);
  expect(registry.platforms.map(({ family }) => family)).toEqual(['web']);
  await registry.close();
});
