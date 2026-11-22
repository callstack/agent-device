import { expect, test } from 'vitest';
import { pluginHome, selectPlugin } from '@agent-device/test-kit';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { storePluginCandidates } from './store.ts';
import { resolveProviderPlugins, startProviderRegistry, type PluginCandidate } from './registry.ts';

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

/** The bundled Apple owner's reserved family claim, as the composition root declares it. */
const builtinApple = {
  source: 'builtin',
  dormant: true,
  declaredClaims: [{ kind: 'platform', id: 'apple' }],
  load: () => undefined,
} as const;

async function startStore(env: HostEnvironment['env'], builtins: readonly PluginCandidate[] = []) {
  const candidates = await storePluginCandidates(env);
  const host = { env, cwd: '/' };
  const resolved = await resolveProviderPlugins([...builtins, ...candidates]);
  return await startProviderRegistry(resolved, host, {
    platformHost: {
      ...host,
      stateDir,
      // What the host says about the machine its commands run on. No family in this test reads them:
      // the plugin under test only names its state dir.
      hostOs: 'linux',
      nodeExecutablePath: '/usr/bin/node',
      nodeVersion: 'v24.0.0',
      temporaryDirectory: '/tmp',
      processId: 4242,
      runCommand: async () => {
        throw new Error('setup must not start a process');
      },
      isFileExecutable: async () => false,
      isFilePresent: async () => false,
      isExecutableOnPath: async () => false,
      processes: {
        list: async () => [],
        readIdentities: async () => new Map(),
        expandTree: (_rootPids, processes) => [...processes],
        judgeRecordedLiveness: async (records) => [...records].map(() => 'unobserved' as const),
        readExecutablePaths: async () => new Map(),
        reapOwnedRecords: async () => {
          throw new Error('setup must not reap host processes');
        },
        withLock: async (params) => await params.task(),
      },
      emitDiagnostic: () => {},
      withDiagnosticTimer: async (_phase, run) => await run(),
      // The managed process service and the detached launcher are part of every plugin host. No
      // family this test serves uses either: the web plugin under test only names its state dir.
      startBackgroundCommand: async () => {
        throw new Error('setup must not keep a command running');
      },
      launchDetached: async () => {
        throw new Error('setup must not launch a detached process');
      },
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

const MACOS_PACKAGE = '@agent-device/macos';
const macOsLeafClaim = `{
  kind: 'platform',
  family: 'apple',
  appleOs: 'macos',
  setup: host => ({ family: 'apple', appleOs: 'macos', bind: () => ({ stateDir: host.stateDir }) }),
}`;

function selectMacOsLeaf(home: string, name = MACOS_PACKAGE) {
  selectPlugin(
    home,
    name,
    `export default () => ({ apiVersion: 3, contributes: [${macOsLeafClaim}] });`,
    { claims: { apiVersion: 3, platform: 'apple', appleOs: 'macos' } },
  );
}

test('a macOS leaf claim coexists with the bundled apple family claim and registers no family', async () => {
  const { home, env } = pluginHome();
  selectMacOsLeaf(home);
  const registry = await startStore(env, [builtinApple]);
  expect(registry.inventory).toMatchObject([
    {
      source: 'store',
      package: MACOS_PACKAGE,
      platform: 'apple',
      appleOs: 'macos',
      state: 'active',
    },
  ]);
  expect(registry.platforms).toEqual([]);
  expect(registry.platformLeaves.map(({ family, appleOs }) => `${family}:${appleOs}`)).toEqual([
    'apple:macos',
  ]);
  await expect(registry.close()).resolves.toMatchObject([
    { platform: 'apple', appleOs: 'macos', source: 'store' },
  ]);
});

test('a second package loses the macOS leaf, and a package cannot take the apple family', async () => {
  const { home, env } = pluginHome();
  selectMacOsLeaf(home);
  selectMacOsLeaf(home, 'later-macos');
  selectPlugin(home, 'whole-apple', "throw new Error('must never import');", {
    claims: { apiVersion: 3, platform: 'apple' },
  });
  const registry = await startStore(env, [builtinApple]);
  expect(
    registry.inventory.map((entry) => [
      entry.package,
      entry.appleOs,
      entry.state === 'failed' ? entry.error.reason : entry.state,
    ]),
  ).toEqual([
    [MACOS_PACKAGE, 'macos', 'active'],
    ['later-macos', 'macos', 'duplicate_platform'],
    ['whole-apple', undefined, 'duplicate_platform'],
  ]);
  expect(registry.platformLeaves).toHaveLength(1);
  await registry.close();
});

test.each([
  ['another family', { apiVersion: 3, platform: 'web', appleOs: 'macos' }],
  ['an Apple OS the owner keeps', { apiVersion: 3, platform: 'apple', appleOs: 'ios' }],
])('a leaf declared for %s is refused before its entry is imported', async (_name, claims) => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'bad-leaf', "throw new Error('must never import');", { claims });
  const registry = await startStore(env, [builtinApple]);
  expect(registry.inventory).toMatchObject([
    { package: 'bad-leaf', state: 'failed', error: { reason: 'invalid_plugin' } },
  ]);
  expect(registry.platformLeaves).toEqual([]);
  await registry.close();
});

test('a bad leaf in a returned plugin neither widens to the apple family nor denies it to the next package', async () => {
  // A candidate with no package metadata claims what its factory returns. Before its claims are
  // readable, the registry reads them off the returned value, and that read must refuse a leaf the
  // family cannot narrow: reading it as the whole `apple` claim would deny that claim to the next
  // package, which is the one that really holds it.
  const badLeaf = {
    source: 'embedder',
    package: 'bad-leaf',
    load: () => ({
      apiVersion: 3,
      contributes: [{ kind: 'platform', family: 'apple', appleOs: 'ios', setup: () => undefined }],
    }),
  } as const;
  const wholeApple = {
    source: 'embedder',
    package: 'whole-apple',
    declaredClaims: [{ kind: 'platform', id: 'apple' }],
    load: () => {
      throw new Error('must never import');
    },
  } as const;

  const resolved = await resolveProviderPlugins([badLeaf, wholeApple]);
  expect(
    resolved
      .inventory()
      .map((entry) => [
        entry.package,
        entry.platform,
        entry.appleOs,
        entry.state === 'failed' ? entry.error.reason : entry.state,
      ]),
  ).toEqual([
    ['bad-leaf', undefined, undefined, 'invalid_plugin'],
    ['whole-apple', 'apple', undefined, 'plugin_load_failed'],
  ]);
});

test('a leaf setup that binds nothing is recorded as failed', async () => {
  const { home, env } = pluginHome();
  selectPlugin(
    home,
    MACOS_PACKAGE,
    `export default () => ({ apiVersion: 3, contributes: [{
      kind: 'platform', family: 'apple', appleOs: 'macos',
      setup: () => ({ family: 'apple', appleOs: 'macos' }),
    }] });`,
    { claims: { apiVersion: 3, platform: 'apple', appleOs: 'macos' } },
  );
  const registry = await startStore(env, [builtinApple]);
  expect(registry.inventory).toMatchObject([
    { appleOs: 'macos', state: 'failed', error: { reason: 'invalid_plugin' } },
  ]);
  expect(registry.platformLeaves).toEqual([]);
  await registry.close();
});
