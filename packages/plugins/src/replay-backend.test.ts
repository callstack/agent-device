import { expect, test, vi } from 'vitest';
import { resolveProviderPlugins, startProviderRegistry } from './registry.ts';
import type { PluginCandidate, PluginRegistryPolicy } from './registry.ts';
import type { ReplayBackend, ReplayBackendHost } from '@agent-device/contracts/replay-backend';
import type { ProviderPluginHost } from './host.ts';
import type { ReplayEnginePlugin } from './replay-backend.ts';

const host = {} as ReplayBackendHost;
const policy: PluginRegistryPolicy = {
  adaptWebDriver: async () => {
    throw new Error('no provider');
  },
};
function candidate(plugin: unknown): PluginCandidate {
  return { source: 'embedder', load: () => plugin };
}
function engine(backend = 'maestro') {
  const runtime: ReplayBackend = {
    id: backend,
    collectSourceFiles: ({ entryPath, entrySource }) => ({ [entryPath]: entrySource }),
    inspectSource: () => ({ title: 'flow', appTarget: 'com.example.app' }),
    runReplay: vi.fn(async () => ({ ok: true as const, data: { replayed: 1 } })),
    exportReplayScript: () => ({ yaml: '- launchApp\n', warnings: [] }),
  };
  const create = vi.fn(async () => runtime);
  const dispose = vi.fn();
  const setup = vi.fn((_host: ProviderPluginHost) => ({ replayBackend: { create }, dispose }));
  return {
    plugin: { apiVersion: 2, kind: 'replay-backend', backend, setup } satisfies ReplayEnginePlugin,
    runtime,
    create,
    dispose,
    setup,
  };
}

test('managed replay setup stays lazy and retains one backend and one cleanup owner', async () => {
  const e = engine();
  const resolved = await resolveProviderPlugins([candidate(e.plugin)]);
  const registry = await startProviderRegistry(resolved, { TOKEN: 'host-value' }, policy);
  expect(e.create).not.toHaveBeenCalled();
  expect(e.setup.mock.calls[0]?.[0]).toMatchObject({ env: { TOKEN: 'host-value' } });
  expect(registry.registrations).toEqual([]);
  expect(registry.inventory).toMatchObject([{ backend: 'maestro', state: 'active' }]);
  const [one, two] = await Promise.all([
    registry.resolveReplayBackend('maestro', host),
    registry.resolveReplayBackend('maestro', host),
  ]);
  expect(one).toBe(e.runtime);
  expect(two).toBe(one);
  expect(e.create).toHaveBeenCalledExactlyOnceWith(host);
  expect(await one.runReplay({} as never)).toMatchObject({
    ok: true as const,
    data: { replayed: 1 },
  });
  expect(await registry.close()).toEqual([
    {
      backend: 'maestro',
      source: 'embedder',
      shutdown: { status: 'ok' },
      dispose: { status: 'ok' },
    },
  ]);
  await registry.close();
  expect(e.dispose).toHaveBeenCalledTimes(1);
  await expect(registry.resolveReplayBackend('maestro', host)).rejects.toMatchObject({
    details: { reason: 'plugin-registry-closed' },
  });
});

test('backend identity is separate from provider identity and first failure claims the backend', async () => {
  const bad = { ...engine().plugin, apiVersion: 99 };
  const other = engine('other');
  const resolved = await resolveProviderPlugins([
    candidate(bad),
    candidate(engine().plugin),
    candidate(other.plugin),
  ]);
  const registry = await startProviderRegistry(resolved, {}, policy);
  expect(registry.claimedProviders).toEqual([]);
  expect(registry.inventory).toMatchObject([
    { backend: 'maestro', state: 'failed', error: { reason: 'incompatible_plugin' } },
    { backend: 'maestro', state: 'failed', error: { reason: 'duplicate_replay_backend' } },
    { backend: 'other', state: 'active' },
  ]);
  await expect(registry.resolveReplayBackend('maestro', host)).rejects.toMatchObject({
    details: { reason: 'incompatible_plugin' },
  });
  expect((await registry.resolveReplayBackend('other', host)).inspectSource('', '')).toEqual({
    title: 'flow',
    appTarget: 'com.example.app',
  });
  await registry.close();
});

test('setup and runtime failures stay distinct from absence and never fall back', async () => {
  const setup = engine('setup');
  setup.setup.mockImplementation(() => {
    throw new Error('setup refused');
  });
  const load = engine('load');
  load.create.mockRejectedValue(new Error('engine failed'));
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([candidate(setup.plugin), candidate(load.plugin)]),
    {},
    policy,
  );
  await expect(registry.resolveReplayBackend('absent', host)).rejects.toMatchObject({
    details: { reason: 'plugin-not-installed' },
  });
  await expect(registry.resolveReplayBackend('setup', host)).rejects.toMatchObject({
    details: { reason: 'plugin_setup_failed' },
  });
  await expect(registry.resolveReplayBackend('load', host)).rejects.toMatchObject({
    details: { reason: 'plugin_load_failed' },
  });
  await expect(registry.resolveReplayBackend('load', host)).rejects.toMatchObject({
    details: { reason: 'plugin_load_failed' },
  });
  expect(load.create).toHaveBeenCalledTimes(1);
  await registry.close();
  expect(load.dispose).toHaveBeenCalledTimes(1);
});

test('the registry rejects the wrong runtime id and cleans up an invalid setup', async () => {
  const wrong = engine('wrong');
  wrong.create.mockResolvedValue({ ...wrong.runtime, id: 'different' });
  const dispose = vi.fn();
  const invalid = { ...engine('invalid').plugin, setup: () => ({ replayBackend: {}, dispose }) };
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([candidate(wrong.plugin), candidate(invalid)]),
    {},
    policy,
  );
  await expect(registry.resolveReplayBackend('wrong', host)).rejects.toMatchObject({
    details: { reason: 'invalid_plugin' },
  });
  await expect(registry.resolveReplayBackend('invalid', host)).rejects.toMatchObject({
    details: { reason: 'invalid_plugin' },
  });
  expect(dispose).toHaveBeenCalledTimes(1);
  await registry.close();
});
