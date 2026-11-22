import { expect, test, vi } from 'vitest';
import { resolveProviderPlugins, startProviderRegistry } from './registry.ts';
import type { PluginCandidate } from './registry.ts';
import type { ReplayBackend, ReplayBackendHost } from '@agent-device/contracts/replay-backend';
import { validateReplayBackendSetup, validateReplayExecutionSetup } from './validate.ts';
import type { PluggedClaim } from './validate.ts';
import type { ReplayExecution } from '@agent-device/contracts/replay-execution';
import type { AgentDevicePlugin } from './contract.ts';
import type { ReplaySetupHost } from './host.ts';

const host = {} as ReplayBackendHost;
/** A candidate that declares the claims its package metadata would declare. */
function candidate(plugin: unknown, declaredClaims?: readonly PluggedClaim[]): PluginCandidate {
  return { source: 'embedder', ...(declaredClaims ? { declaredClaims } : {}), load: () => plugin };
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
  const setup = vi.fn((_host: ReplaySetupHost) => ({ replayBackend: { create }, dispose }));
  const plugin: AgentDevicePlugin = {
    apiVersion: 3,
    contributes: [{ kind: 'replay-backend', backend, setup }],
  };
  return { plugin, runtime, create, dispose, setup };
}

function nativeExecution() {
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
  const dispose = vi.fn();
  const setup = vi.fn(() => ({ execution: { create }, dispose }));
  const plugin: AgentDevicePlugin = {
    apiVersion: 3,
    contributes: [{ kind: 'replay-execution', id: 'ad', setup }],
  };
  return { plugin, execution, create, dispose, setup };
}

test('one backend disposer cannot delay another backend disposer', async () => {
  const first = engine('first');
  const second = engine('second');
  let release!: () => void;
  // Close starts with the claim activated last. That one hangs, so a serial teardown would never
  // reach the other claim before the release.
  second.dispose.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([candidate(first.plugin), candidate(second.plugin)]),
    { env: {}, cwd: '/' },
  );
  const closing = registry.close();
  await new Promise((resolve) => setImmediate(resolve));
  expect(second.dispose).toHaveBeenCalledTimes(1);
  expect(first.dispose).toHaveBeenCalledTimes(1);
  release();
  expect(await closing).toHaveLength(2);
});

test('a duplicate claim keeps its duplicate reason when its factory also fails', async () => {
  const resolved = await resolveProviderPlugins([
    candidate(engine().plugin, [{ kind: 'replay-backend', id: 'maestro' }]),
    {
      source: 'embedder',
      declaredClaims: [{ kind: 'replay-backend', id: 'maestro' }],
      load: () => {
        throw new Error('factory failed');
      },
    },
  ]);
  const registry = await startProviderRegistry(resolved, { env: {}, cwd: '/' });
  expect(registry.inventory).toMatchObject([
    { backend: 'maestro', state: 'active' },
    { backend: 'maestro', state: 'failed', error: { reason: 'duplicate_replay_backend' } },
  ]);
  await registry.close();
});

test('managed replay setup stays lazy and retains one backend and one cleanup owner', async () => {
  const e = engine();
  const resolved = await resolveProviderPlugins([candidate(e.plugin)]);
  const registry = await startProviderRegistry(resolved, {
    env: { TOKEN: 'host-value' },
    cwd: '/',
  });
  expect(e.create).not.toHaveBeenCalled();
  // The replay setup host grants only version and error construction.
  expect(e.setup.mock.calls[0]?.[0]).toMatchObject({ clientVersion: expect.any(String) });
  expect(Object.keys(e.setup.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
    'clientVersion',
    'createError',
  ]);
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
    candidate(bad, [{ kind: 'replay-backend', id: 'maestro' }]),
    candidate(engine().plugin, [{ kind: 'replay-backend', id: 'maestro' }]),
    candidate(other.plugin, [{ kind: 'replay-backend', id: 'other' }]),
  ]);
  const registry = await startProviderRegistry(resolved, { env: {}, cwd: '/' });
  expect(registry.claimedProviders).toEqual([]);
  expect(registry.inventory).toMatchObject([
    { backend: 'maestro', state: 'failed', error: { reason: 'incompatible-plugin-api' } },
    { backend: 'maestro', state: 'failed', error: { reason: 'duplicate_replay_backend' } },
    { backend: 'other', state: 'active' },
  ]);
  await expect(registry.resolveReplayBackend('maestro', host)).rejects.toMatchObject({
    details: { reason: 'incompatible-plugin-api' },
  });
  expect((await registry.resolveReplayBackend('other', host)).inspectSource('', '')).toEqual({
    title: 'flow',
    appTarget: 'com.example.app',
  });
  await registry.close();
});

test('an embedder candidate on another contract version answers native execution with its reason', async () => {
  // An embedding host's plugin carries no package metadata, so nothing names its claim before the
  // factory runs. Its validation failure still answers the selection that named this runtime's
  // native execution, rather than reporting that nothing is installed.
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([candidate({ ...nativeExecution().plugin, apiVersion: 99 })]),
    { env: {}, cwd: '/' },
  );
  expect(registry.inventory).toMatchObject([
    { source: 'embedder', state: 'failed', error: { reason: 'incompatible-plugin-api' } },
  ]);
  await expect(registry.resolveReplayExecution('@agent-device/replay')).rejects.toMatchObject({
    details: { reason: 'incompatible-plugin-api', declaredApiVersion: 99 },
  });
  await registry.close();
});

test('the shipped version 2 replay shapes answer their selection with incompatible-plugin-api', async () => {
  // The real version 2 return values of @agent-device/replay and @agent-device/maestro: a top-level
  // `kind` and `backend`, with no `contributes`.
  const versionTwoReplay = { apiVersion: 2, kind: 'replay-backend', backend: 'ad', setup: vi.fn() };
  const versionTwoMaestro = {
    apiVersion: 2,
    kind: 'replay-backend',
    backend: 'maestro',
    setup: vi.fn(),
  };
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([candidate(versionTwoReplay), candidate(versionTwoMaestro)]),
    { env: {}, cwd: '/' },
  );
  expect(registry.inventory).toMatchObject([
    { state: 'failed', error: { reason: 'incompatible-plugin-api' } },
    { backend: 'maestro', state: 'failed', error: { reason: 'incompatible-plugin-api' } },
  ]);
  await expect(registry.resolveReplayExecution('@agent-device/replay')).rejects.toMatchObject({
    details: { reason: 'incompatible-plugin-api', declaredApiVersion: 2 },
  });
  await expect(registry.resolveReplayBackend('maestro', host)).rejects.toMatchObject({
    details: { reason: 'incompatible-plugin-api', declaredApiVersion: 2 },
  });
  expect(versionTwoReplay.setup).not.toHaveBeenCalled();
  expect(versionTwoMaestro.setup).not.toHaveBeenCalled();
  await registry.close();
});

test('a format claim of the reserved ad id fails while native execution claims it', async () => {
  const reserved = engine('ad');
  const native = nativeExecution();
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([
      // The declared claim is what a store package's metadata would have declared, which is how the
      // failed package keeps its identity in the inventory.
      candidate(reserved.plugin, [{ kind: 'replay-backend', id: 'ad' }]),
      candidate(native.plugin),
    ]),
    { env: {}, cwd: '/' },
  );
  expect(registry.inventory).toMatchObject([
    { backend: 'ad', state: 'failed', error: { reason: 'reserved_replay_backend' } },
    { backend: 'ad', state: 'active' },
  ]);
  expect(reserved.setup).not.toHaveBeenCalled();
  await expect(registry.resolveReplayBackend('ad', host)).rejects.toMatchObject({
    details: { reason: 'reserved_replay_backend' },
  });
  await expect(registry.resolveReplayExecution()).resolves.toBe(native.execution);
  await registry.close();
});

test('setup failures stay permanent while failed lazy loads can retry without fallback', async () => {
  const setup = engine('setup');
  setup.setup.mockImplementation(() => {
    throw new Error('setup refused');
  });
  const load = engine('load');
  load.create.mockRejectedValueOnce(new Error('engine failed'));
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([candidate(setup.plugin), candidate(load.plugin)]),
    { env: {}, cwd: '/' },
  );
  await expect(registry.resolveReplayBackend('absent', host)).rejects.toMatchObject({
    details: { reason: 'plugin-not-installed' },
  });
  await expect(registry.resolveReplayBackend('setup', host)).rejects.toMatchObject({
    details: { reason: 'plugin_setup_failed' },
  });
  await expect(registry.resolveReplayBackend('load', host)).rejects.toMatchObject({
    message: 'engine failed',
    details: { reason: 'plugin_load_failed' },
  });
  expect(registry.inventory[1]).toMatchObject({
    state: 'failed',
    error: { reason: 'plugin_load_failed' },
  });
  const [one, two] = await Promise.all([
    registry.resolveReplayBackend('load', host),
    registry.resolveReplayBackend('load', host),
  ]);
  expect(one).toBe(load.runtime);
  expect(two).toBe(one);
  expect(await registry.resolveReplayBackend('load', host)).toBe(one);
  expect(load.create).toHaveBeenCalledTimes(2);
  expect(registry.inventory[1]).toMatchObject({ state: 'active' });
  await expect(registry.resolveReplayBackend('setup', host)).rejects.toMatchObject({
    details: { reason: 'plugin_setup_failed' },
  });
  expect(setup.setup).toHaveBeenCalledTimes(1);
  await registry.close();
  expect(load.dispose).toHaveBeenCalledTimes(1);
});

test('the registry rejects the wrong runtime id and cleans up an invalid setup', async () => {
  const wrong = engine('wrong');
  wrong.create.mockResolvedValue({ ...wrong.runtime, id: 'different' });
  const dispose = vi.fn();
  const invalid: AgentDevicePlugin = {
    apiVersion: 3,
    contributes: [
      {
        kind: 'replay-backend',
        backend: 'invalid',
        setup: () => ({ replayBackend: {} as never, dispose }),
      },
    ],
  };
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([candidate(wrong.plugin), candidate(invalid)]),
    { env: {}, cwd: '/' },
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

test('native execution retries failed lazy loads while sharing claims, caching and disposal', async () => {
  const native = nativeExecution();
  native.create.mockRejectedValueOnce(new Error('native engine failed'));
  const competing = nativeExecution();
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([candidate(native.plugin), candidate(competing.plugin)]),
    { env: {}, cwd: '/' },
  );
  expect(registry.inventory).toMatchObject([
    { backend: 'ad', state: 'active' },
    { backend: 'ad', state: 'failed', error: { reason: 'duplicate_replay_execution' } },
  ]);
  expect(competing.setup).not.toHaveBeenCalled();
  await expect(registry.resolveReplayExecution()).rejects.toMatchObject({
    message: 'native engine failed',
    details: { reason: 'plugin_load_failed' },
  });
  expect(native.create).toHaveBeenCalledTimes(1);
  expect(registry.inventory[0]).toMatchObject({
    state: 'failed',
    error: { reason: 'plugin_load_failed' },
  });
  const [one, two] = await Promise.all([
    registry.resolveReplayExecution(),
    registry.resolveReplayExecution(),
  ]);
  expect(one).toBe(two);
  expect(one).toBe(native.execution);
  expect(await registry.resolveReplayExecution()).toBe(one);
  expect(native.create).toHaveBeenCalledTimes(2);
  expect(registry.inventory[0]).toMatchObject({ backend: 'ad', state: 'active' });
  expect(registry.inventory[0]?.error).toBeUndefined();
  await registry.close();
  expect(native.dispose).toHaveBeenCalledTimes(1);
  await expect(registry.resolveReplayExecution()).rejects.toMatchObject({
    details: { reason: 'plugin-registry-closed' },
  });
});

test.each([
  [{ apiVersion: 99 }, 'incompatible-plugin-api'],
  [
    { contributes: [{ kind: 'replay-execution', id: 'ad', setup: () => ({ execution: {} }) }] },
    'invalid_plugin',
  ],
  [
    {
      contributes: [
        {
          kind: 'replay-execution',
          id: 'ad',
          setup: () => {
            throw new Error('failed setup');
          },
        },
      ],
    },
    'plugin_setup_failed',
  ],
  [
    {
      contributes: [
        {
          kind: 'replay-execution',
          id: 'ad',
          setup: () => ({ execution: { create: () => ({}) } }),
        },
      ],
    },
    'invalid_plugin',
  ],
])(
  'selected native execution failures preserve their typed cause: %s',
  async (override, reason) => {
    const registry = await startProviderRegistry(
      await resolveProviderPlugins([
        candidate(
          {
            apiVersion: 3,
            contributes: [
              {
                kind: 'replay-execution',
                id: 'ad',
                setup: () => ({ execution: { create: () => ({}) } }),
              },
            ],
            ...override,
          },
          [{ kind: 'replay-execution', id: 'ad' }],
        ),
      ]),
      { env: {}, cwd: '/' },
    );
    await expect(registry.resolveReplayExecution()).rejects.toMatchObject({ details: { reason } });
    await registry.close();
  },
);

test.each([
  [{ replayBackend: { create: vi.fn() }, execution: { create: vi.fn() } }],
  [{ execution: { create: vi.fn() } }],
  [{ replayBackend: {} }],
  ['not-an-object'],
])('format backend setup rejects %s', (setup) => {
  expect(() => validateReplayBackendSetup(setup)).toThrow(
    expect.objectContaining({ details: { reason: 'invalid_plugin' } }),
  );
});

test.each([
  [{ replayBackend: { create: vi.fn() }, execution: { create: vi.fn() } }],
  [{ replayBackend: { create: vi.fn() } }],
  [{ execution: {} }],
])('native execution setup rejects %s', (setup) => {
  expect(() => validateReplayExecutionSetup(setup)).toThrow(
    expect.objectContaining({ details: { reason: 'invalid_plugin' } }),
  );
});

test('wrong native capability fails inventory, disposes setup and keeps its first claim', async () => {
  const wrong = nativeExecution();
  wrong.create.mockResolvedValue({} as never);
  const later = nativeExecution();
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([
      candidate(wrong.plugin),
      candidate(later.plugin),
      candidate(engine('maestro').plugin),
    ]),
    { env: {}, cwd: '/' },
  );
  expect(later.setup).not.toHaveBeenCalled();
  await expect(registry.resolveReplayExecution()).rejects.toMatchObject({
    details: { reason: 'invalid_plugin' },
  });
  expect(wrong.create).toHaveBeenCalledOnce();
  expect(registry.inventory).toMatchObject([
    { backend: 'ad', state: 'failed', error: { reason: 'invalid_plugin' } },
    { backend: 'ad', state: 'failed', error: { reason: 'duplicate_replay_execution' } },
    { backend: 'maestro', state: 'active' },
  ]);
  await registry.close();
  expect(wrong.dispose).toHaveBeenCalledOnce();
});

test('a package name cannot select an active foreign backend for native execution', async () => {
  const maestro = engine();
  const packageName = '@agent-device/maestro';
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([
      { ...candidate(maestro.plugin), package: packageName },
      {
        source: 'store',
        package: '@agent-device/replay',
        load: () => {
          throw new Error('selected native package is unreadable');
        },
      },
    ]),
    { env: {}, cwd: '/' },
  );
  try {
    await expect(registry.resolveReplayExecution(packageName)).rejects.toMatchObject({
      details: { reason: 'plugin-not-installed', backend: 'ad' },
    });
    await expect(registry.resolveReplayExecution('@agent-device/replay')).rejects.toMatchObject({
      details: { reason: 'plugin_load_failed' },
    });
    expect(maestro.create).not.toHaveBeenCalled();
    expect(await registry.resolveReplayBackend('maestro', host, packageName)).toBe(maestro.runtime);
  } finally {
    await registry.close();
  }
});

test('a selected native package load failure cannot masquerade as absence by its message', async () => {
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([
      {
        source: 'store',
        package: '@agent-device/replay',
        load: () => {
          throw new Error('Replay backend is not installed: ad');
        },
      },
    ]),
    { env: {}, cwd: '/' },
  );
  try {
    await expect(registry.resolveReplayExecution('@agent-device/replay')).rejects.toMatchObject({
      details: {
        reason: 'plugin_load_failed',
        package: '@agent-device/replay',
        updateCommand: 'agent-device plugins update @agent-device/replay',
      },
    });
  } finally {
    await registry.close();
  }
});

test('a multi-kind package activates its replay claim even when its provider setup fails', async () => {
  const multi: AgentDevicePlugin = {
    apiVersion: 3,
    contributes: [
      {
        kind: 'provider',
        provider: 'multi',
        credentials: { variables: [] },
        setup: async () => {
          throw new Error('provider setup failed');
        },
      },
      engine('maestro').plugin.contributes[0]!,
    ],
  };
  const registry = await startProviderRegistry(await resolveProviderPlugins([candidate(multi)]), {
    env: {},
    cwd: '/',
  });
  expect(registry.registrations).toEqual([]);
  expect(registry.inventory).toMatchObject([
    { provider: 'multi', state: 'failed', error: { reason: 'plugin_setup_failed' } },
    { backend: 'maestro', state: 'active' },
  ]);
  const backend = await registry.resolveReplayBackend('maestro', host);
  expect(backend.id).toBe('maestro');
  const outcomes = await registry.close();
  expect(outcomes).toEqual([
    {
      backend: 'maestro',
      source: 'embedder',
      shutdown: { status: 'ok' },
      dispose: { status: 'ok' },
    },
  ]);
});

test('the replay-only scope sets up no provider claim', async () => {
  const providerSetup = vi.fn(async () => {
    throw new Error('unexpected provider setup');
  });
  const multi: AgentDevicePlugin = {
    apiVersion: 3,
    contributes: [
      {
        kind: 'provider',
        provider: 'scoped',
        credentials: { variables: [] },
        setup: providerSetup,
      },
      engine('maestro').plugin.contributes[0]!,
    ],
  };
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([candidate(multi)]),
    { env: {}, cwd: '/' },
    {},
    'replay-backends',
  );
  expect(providerSetup).not.toHaveBeenCalled();
  expect(registry.registrations).toEqual([]);
  expect(registry.inventory).toMatchObject([
    { provider: 'scoped', state: 'active' },
    { backend: 'maestro', state: 'active' },
  ]);
  await expect(registry.resolveReplayBackend('maestro', host)).resolves.toMatchObject({
    id: 'maestro',
  });
  await registry.close();
});

test('close starts activated claims in reverse order with per-step outcomes', async () => {
  const order: string[] = [];
  const make = (name: string, failShutdown: boolean) => {
    const plugin: AgentDevicePlugin = {
      apiVersion: 3,
      contributes: [
        {
          kind: 'provider',
          provider: name,
          credentials: { variables: [] },
          setup: async () => ({
            runtime: {
              provider: name,
              ownsDevice: () => false,
              getInteractor: () => undefined,
              deviceInventoryProvider: async () => [],
              leaseLifecycle: {},
              shutdown: async () => {
                order.push(`${name}-shutdown`);
                if (failShutdown) throw new Error(`${name} shutdown failed`);
              },
            } as never,
            platformModule: {
              owner: { kind: 'provider-runtime', provider: name, instance: 'test' },
              loadRuntime: async () => {
                throw new Error('lazy');
              },
            },
            dispose: async () => {
              order.push(`${name}-dispose`);
            },
          }),
        },
      ],
    };
    return plugin;
  };
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([
      candidate(make('first', false)),
      candidate(make('second', true)),
    ]),
    { env: {}, cwd: '/' },
  );
  const outcomes = await registry.close();
  // Teardown starts in reverse activation order; each runtime shuts down before its own disposer.
  expect(order[0]).toBe('second-shutdown');
  expect(order.indexOf('second-shutdown')).toBeLessThan(order.indexOf('first-shutdown'));
  expect(order.indexOf('second-shutdown')).toBeLessThan(order.indexOf('second-dispose'));
  expect(order.indexOf('first-shutdown')).toBeLessThan(order.indexOf('first-dispose'));
  expect([...order].sort()).toEqual([
    'first-dispose',
    'first-shutdown',
    'second-dispose',
    'second-shutdown',
  ]);
  expect(outcomes).toEqual([
    {
      provider: 'second',
      source: 'embedder',
      shutdown: {
        status: 'failed',
        error: expect.objectContaining({ message: 'second shutdown failed' }),
      },
      dispose: { status: 'ok' },
    },
    {
      provider: 'first',
      source: 'embedder',
      shutdown: { status: 'ok' },
      dispose: { status: 'ok' },
    },
  ]);
  // Close is memoized: a second call returns the same outcomes and runs nothing again.
  expect(await registry.close()).toBe(outcomes);
  expect(order).toHaveLength(4);
});
