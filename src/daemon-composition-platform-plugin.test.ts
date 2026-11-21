import path from 'node:path';
import { expect, test } from 'vitest';
import { pluginHome, selectPlugin } from '@agent-device/test-kit';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';
import { createManagedWebBackend } from './platform-runtime-managed-web-backend.ts';

const webPackage = '@agent-device/web';
const webPlugin = `
  export default () => ({
    apiVersion: 3,
    contributes: [{
      kind: 'platform',
      family: 'web',
      setup(host) {
        return {
          family: 'web',
          createInteractor: async () => ({ activate: async () => {} }),
          inventoryModule: {
            family: 'web',
            loadInventory: async () => ({
              discover: async () => [{ platform: 'web', kind: 'device', id: host.stateDir }],
            }),
          },
          runtimeModule: { family: 'web', loadRuntime() { throw new Error('must stay lazy'); } },
          withRequestProvider: async (_, task) => task(),
          operations: {
            setup() {},
            doctor: async () => ({ status: { stateDir: host.stateDir }, exitCode: 0 }),
            cleanupOrphans() {},
            browserLifecycleCheck() {},
            createProvider() {},
            resolveRequestProvider() {},
          },
        };
      },
    }],
  });
`;

const linuxPackage = '@agent-device/linux';
const linuxPlugin = `
  export default () => ({
    apiVersion: 3,
    contributes: [{
      kind: 'platform',
      family: 'linux',
      setup(host) {
        return {
          family: 'linux',
          createInteractor: async () => ({ activate: async () => {} }),
          inventoryModule: {
            family: 'linux',
            loadInventory: async () => ({
              discover: async () => [{ platform: 'linux', kind: 'device', target: 'desktop', id: 'local', name: host.stateDir }],
            }),
          },
          runtimeModule: { family: 'linux', loadRuntime() { throw new Error('must stay lazy'); } },
          withRequestProvider: async (_, task) => task(),
          operations: {
            toolchainCheck: async () => ({
              id: 'toolchain',
              status: 'pass',
              summary: 'Linux desktop tools on ' + host.stateDir,
            }),
          },
        };
      },
    }],
  });
`;

function selectWeb(home: string) {
  selectPlugin(home, webPackage, webPlugin, { claims: { apiVersion: 3, platform: 'web' } });
}

function selectLinux(home: string) {
  selectPlugin(home, linuxPackage, linuxPlugin, { claims: { apiVersion: 3, platform: 'linux' } });
}

async function withDaemonComposition(
  env: NodeJS.ProcessEnv,
  baseDir: string,
  run: (
    deps: Awaited<ReturnType<typeof createDaemonRuntimeDeps>>,
    host: { env: NodeJS.ProcessEnv; cwd: string },
  ) => Promise<void>,
) {
  const host = { env: { ...env, AGENT_DEVICE_STATE_DIR: baseDir }, cwd: baseDir };
  const sessionsDir = path.join(baseDir, 'sessions');
  await createRuntimeStateHandle().run(async () => {
    const deps = await createDaemonRuntimeDeps({
      host,
      baseDir,
      sessionsDir,
      assertShutdownAllowed: undefined,
      resolveSessionDir: (session) => path.join(sessionsDir, session),
      resolveSessionArtifacts: () => {
        throw new Error('unused');
      },
      openWebSessionNames: () => [],
    });
    try {
      await run(deps, host);
    } finally {
      await deps.shutdownProviderRuntimes();
    }
  });
}

const inventoryScope = () => ({
  signal: new AbortController().signal,
  diagnostics: { emit() {} },
  progress: { report() {} },
});

test('daemon composition sets up a stored web platform and its inventory and doctor use the registration', async () => {
  const { home, env } = pluginHome();
  const stateDir = path.join(home, 'state');
  selectWeb(home);
  await withDaemonComposition(env, stateDir, async (deps, host) => {
    expect(deps.pluginInventory).toContainEqual(
      expect.objectContaining({
        package: webPackage,
        platform: 'web',
        source: 'store',
        state: 'active',
      }),
    );
    const devices = await deps.requestRouter.deviceInventoryGateways.localOnly.discover(
      { platform: 'web' },
      inventoryScope(),
    );
    expect(devices).toEqual([expect.objectContaining({ id: stateDir, platform: 'web' })]);
    await expect(deps.interactorResolution.resolve(devices[0]!, {})).resolves.toHaveProperty(
      'activate',
    );
    await expect(createManagedWebBackend(host).doctor({ stateDir })).resolves.toMatchObject({
      status: { stateDir },
      exitCode: 0,
    });
  });
});

test('a store claim cannot replace the bundled apple family', async () => {
  const family = 'apple';
  const { home, env } = pluginHome();
  selectPlugin(home, webPackage, webPlugin.replaceAll("'web'", JSON.stringify(family)), {
    claims: { apiVersion: 3, platform: family },
  });
  const stateDir = path.join(home, 'state');
  await withDaemonComposition(env, stateDir, async (deps, host) => {
    expect(deps.pluginInventory).toContainEqual(
      expect.objectContaining({
        package: webPackage,
        platform: family,
        state: 'failed',
        error: expect.objectContaining({ reason: 'duplicate_platform' }),
      }),
    );
    await expect(createManagedWebBackend(host).doctor({ stateDir })).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'plugin-not-installed', family: 'web' }),
    });
  });
});

test('an installed Linux plugin answers the daemon composition it is registered into', async () => {
  // The whole store-to-daemon path for the family, with nothing Linux-specific in core: the plugin
  // registers from the store, its inventory answers a discovery request, its interactor is what a
  // Linux device resolves to, and `doctor --platform linux` prints the row the plugin computed from
  // the host it was set up with.
  const { home, env } = pluginHome();
  const stateDir = path.join(home, 'state');
  selectLinux(home);
  await withDaemonComposition(env, stateDir, async (deps) => {
    expect(deps.pluginInventory).toContainEqual(
      expect.objectContaining({
        package: linuxPackage,
        platform: 'linux',
        source: 'store',
        state: 'active',
      }),
    );
    const devices = await deps.requestRouter.deviceInventoryGateways.localOnly.discover(
      { platform: 'linux' },
      inventoryScope(),
    );
    expect(devices).toEqual([
      expect.objectContaining({ platform: 'linux', id: 'local', target: 'desktop' }),
    ]);
    await expect(
      deps.interactorResolution.resolve(
        { platform: 'linux', id: 'local', kind: 'device', target: 'desktop', name: 'Local' },
        {},
      ),
    ).resolves.toHaveProperty('activate');
    const check = await deps.hostDiagnostics.toolchainCheck('linux', {
      stateDir,
      metroPort: 8081,
      shouldProbeMetro: false,
      isProviderDevice: () => false,
      emitProgress: () => {},
      listLocalDeviceInventory: async () => [],
      shouldPropagateInventoryProbeError: () => false,
      transportOverrides: Object.freeze({}),
    });
    expect(check).toMatchObject({ id: 'toolchain', status: 'pass' });
  });
});

test('an installed Linux plugin claiming Linux without the family registration fails validation', async () => {
  // Linux is no longer bundled, so a store claim is not a duplicate — it is the family's only
  // registration. The store validates the registration shape before the composition sees it, so a
  // package that answers another family's shape never becomes the Linux runtime.
  const family = 'linux';
  const { home, env } = pluginHome();
  selectPlugin(home, webPackage, webPlugin.replaceAll("'web'", JSON.stringify(family)), {
    claims: { apiVersion: 3, platform: family },
  });
  const stateDir = path.join(home, 'state');
  await withDaemonComposition(env, stateDir, async (deps, host) => {
    expect(deps.pluginInventory).toContainEqual(
      expect.objectContaining({
        package: webPackage,
        platform: family,
        state: 'failed',
        error: expect.objectContaining({ reason: 'invalid_plugin' }),
      }),
    );
    await expect(createManagedWebBackend(host).doctor({ stateDir })).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'plugin-not-installed', family: 'web' }),
    });
  });
});

test('absent web reports the same install hint for daemon inventory, interactors and web doctor', async () => {
  const { home, env } = pluginHome();
  const stateDir = path.join(home, 'state');
  await withDaemonComposition(env, stateDir, async (deps, host) => {
    const gateway = deps.requestRouter.deviceInventoryGateways.localOnly;
    const discover = () => gateway.discover({ platform: 'web' }, inventoryScope());
    const absent = {
      code: 'UNSUPPORTED_PLATFORM',
      details: expect.objectContaining({
        reason: 'plugin-not-installed',
        package: webPackage,
        installCommand: expect.stringContaining('agent-device plugins add @agent-device/web'),
      }),
    };
    await expect(discover()).rejects.toMatchObject(absent);
    await expect(
      deps.interactorResolution.resolve(
        {
          platform: 'web',
          id: 'fixture',
          kind: 'device',
          name: 'Fixture',
        },
        {},
      ),
    ).rejects.toMatchObject(absent);
    await expect(createManagedWebBackend(host).doctor({ stateDir })).rejects.toMatchObject(absent);

    selectWeb(home);
    await expect(discover()).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'daemon-plugin-set-stale', package: webPackage }),
    });
  });
});
