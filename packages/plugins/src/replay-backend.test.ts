import { expect, test, vi } from 'vitest';
import { resolveProviderPlugins, startProviderRegistry } from './registry.ts';
import type { PluginCandidate, PluginRegistryPolicy } from './registry.ts';
import type { ReplayBackend, ReplayBackendHost } from '@agent-device/contracts/replay-backend';
import { validateReplayEngineSetup } from './validate.ts';
import type { ReplayExecution } from '@agent-device/contracts/replay-execution';
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

test('one backend disposer cannot delay another backend disposer', async () => {
  const first = engine('first');
  const second = engine('second');
  let release!: () => void;
  first.dispose.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([candidate(first.plugin), candidate(second.plugin)]),
    {},
    policy,
  );
  const closing = registry.close();
  await Promise.resolve();
  expect(second.dispose).toHaveBeenCalledTimes(1);
  release();
  expect(await closing).toHaveLength(2);
});

test('native execution shares backend claims, lazy creation and registry disposal', async () => {
  const execution: ReplayExecution = {
    inspectAdReplay: vi.fn(() => {
      throw new Error('inspection is outside registry ownership');
    }),
    runAdReplay: vi.fn(async () => {
      throw new Error('dispatch is outside registry ownership');
    }),
    runReplayTestSuite: vi.fn(async () => {
      throw new Error('scheduling is outside registry ownership');
    }),
  };
  const create = vi.fn(async () => execution);
  const competing = { setup: vi.fn(() => ({ execution: { create } })) };
  const competingPlugin = {
    apiVersion: 2,
    kind: 'replay-backend',
    backend: 'ad',
    setup: competing.setup,
  };
  const dispose = vi.fn();
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([
      candidate({
        apiVersion: 2,
        kind: 'replay-backend',
        backend: 'ad',
        setup: () => ({ execution: { create }, dispose }),
      }),
      candidate(competingPlugin),
    ]),
    {},
    policy,
  );
  expect(registry.inventory).toMatchObject([
    { backend: 'ad', state: 'active' },
    { backend: 'ad', state: 'failed', error: { reason: 'duplicate_replay_backend' } },
  ]);
  expect(competing.setup).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  const [one, two] = await Promise.all([
    registry.resolveReplayExecution(),
    registry.resolveReplayExecution(),
  ]);
  expect(one).toBe(two);
  expect(one).toBe(execution);
  expect(create).toHaveBeenCalledTimes(1);
  await registry.close();
  expect(dispose).toHaveBeenCalledTimes(1);
  await expect(registry.resolveReplayExecution()).rejects.toMatchObject({
    details: { reason: 'plugin-registry-closed' },
  });
});

test.each([
  [{ apiVersion: 99 }, 'incompatible_plugin'],
  [{ setup: () => ({ execution: {} }) }, 'invalid_plugin'],
  [
    {
      setup: () => {
        throw new Error('failed setup');
      },
    },
    'plugin_setup_failed',
  ],
  [{ setup: () => ({ execution: { create: () => ({}) } }) }, 'invalid_plugin'],
])(
  'selected native execution failures preserve their typed cause: %s',
  async (override, reason) => {
    const registry = await startProviderRegistry(
      await resolveProviderPlugins([
        candidate({
          apiVersion: 2,
          kind: 'replay-backend',
          backend: 'ad',
          setup: () => ({ execution: { create: () => ({}) } }),
          ...override,
        }),
      ]),
      {},
      policy,
    );
    await expect(registry.resolveReplayExecution()).rejects.toMatchObject({ details: { reason } });
    await registry.close();
  },
);

test.each([
  ['ad', { replayBackend: { create: vi.fn() } }],
  ['maestro', { execution: { create: vi.fn() } }],
  ['custom', { execution: { create: vi.fn() } }],
])('setup validates the factory against backend %s', (backend, setup) => {
  expect(() => validateReplayEngineSetup(setup, backend)).toThrow(
    expect.objectContaining({ details: { reason: 'invalid_plugin' } }),
  );
});

test('wrong native capability fails inventory, disposes setup and keeps its first claim', async () => {
  const wrong = engine('ad');
  const laterSetup = vi.fn(() => ({ execution: { create: vi.fn() } }));
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([
      candidate(wrong.plugin),
      candidate({ apiVersion: 2, kind: 'replay-backend', backend: 'ad', setup: laterSetup }),
      candidate(engine('maestro').plugin),
    ]),
    {},
    policy,
  );
  expect(registry.inventory).toMatchObject([
    { backend: 'ad', state: 'failed', error: { reason: 'invalid_plugin' } },
    { backend: 'ad', state: 'failed', error: { reason: 'duplicate_replay_backend' } },
    { backend: 'maestro', state: 'active' },
  ]);
  expect(wrong.dispose).toHaveBeenCalledOnce();
  expect(wrong.create).not.toHaveBeenCalled();
  expect(laterSetup).not.toHaveBeenCalled();
  await expect(registry.resolveReplayExecution()).rejects.toMatchObject({
    details: { reason: 'invalid_plugin' },
  });
  await registry.close();
  expect(wrong.dispose).toHaveBeenCalledOnce();
});
