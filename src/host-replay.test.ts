import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { prepareDaemonCommandRequest } from '@agent-device/command-surface';
import { createAgentDeviceClient } from '@agent-device/client';
import type { ReplayEnginePlugin } from '@agent-device/plugins/replay-backend';
import { resolveProviderPlugins } from '@agent-device/plugins/registry';
import { storePluginCandidates } from '@agent-device/plugins/store';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { startAgentDevice } from './host.ts';

async function trackSourceRegistries() {
  const pluginRegistry = await import('@agent-device/plugins/registry');
  const original = pluginRegistry.startProviderRegistry;
  const closed = vi.fn();
  const started = vi.spyOn(pluginRegistry, 'startProviderRegistry');
  started.mockImplementation(async (...args) => {
    const registry = await original(...args);
    return {
      ...registry,
      close: async () => {
        closed();
        return await registry.close();
      },
    };
  });
  return { started, closed };
}

test('a multi-flow Maestro suite collects real includes in one disposable client scope', async () => {
  const root = mkdtempForTestSync('maestro-suite-sources-');
  const child = path.join(root, 'child.yaml');
  const entries = ['first.yaml', 'second.yaml'].map((name) => path.join(root, name));
  const flow = 'appId: demo.app\n---\n- runFlow: child.yaml\n';
  const included = 'appId: demo.app\n---\n- back\n';
  for (const entry of entries) fs.writeFileSync(entry, flow);
  fs.writeFileSync(child, included);
  const scope = await trackSourceRegistries();
  try {
    const result = await prepareDaemonCommandRequest(
      'test',
      { paths: entries, backend: 'maestro' },
      { env: process.env, cwd: root },
    );
    expect(result.options.replayScriptSources).toEqual(
      entries.map((entry) => ({ entry, files: { [entry]: flow, [child]: included } })),
    );
    expect(scope.started).toHaveBeenCalledTimes(1);
    expect(scope.closed).toHaveBeenCalledTimes(1);
  } finally {
    scope.started.mockRestore();
  }
});

test('a failed Maestro source bundle closes its client registry', async () => {
  const root = mkdtempForTestSync('maestro-suite-large-source-');
  const entry = path.join(root, 'large.yaml');
  fs.writeFileSync(entry, `# ${'x'.repeat(2 * 1024 * 1024)}\n`);
  const scope = await trackSourceRegistries();
  try {
    await expect(
      prepareDaemonCommandRequest(
        'test',
        { paths: [entry], backend: 'maestro' },
        { env: process.env, cwd: root },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS', details: { limitBytes: 2 * 1024 * 1024 } });
    expect(scope.started).toHaveBeenCalledTimes(1);
    expect(scope.closed).toHaveBeenCalledTimes(1);
  } finally {
    scope.started.mockRestore();
  }
});

test.each([undefined, 'maestro'])(
  'native-only source collection with backend %s never starts a plugin registry',
  async (backend) => {
    const root = mkdtempForTestSync('native-suite-sources-');
    const entry = path.join(root, 'suite.ad');
    const script = 'open demo.app\nclose\n';
    fs.writeFileSync(entry, script);
    const scope = await trackSourceRegistries();
    try {
      const result = await prepareDaemonCommandRequest(
        'test',
        { paths: [entry], backend },
        { env: { AGENT_DEVICE_HOME: path.join(root, 'empty-home') }, cwd: root },
      );
      expect(result.options.replayScriptSources).toEqual([{ entry, files: { [entry]: script } }]);
      expect(scope.started).not.toHaveBeenCalled();
      expect(scope.closed).not.toHaveBeenCalled();
    } finally {
      scope.started.mockRestore();
    }
  },
);

function fixture() {
  const root = mkdtempForTestSync('embedded-replay-');
  const entry = path.join(root, 'flow.yaml');
  fs.writeFileSync(entry, 'appId: com.example.app\n---\n- runFlow: child.yaml\n');
  fs.writeFileSync(
    path.join(root, 'child.yaml'),
    'appId: com.example.app\n---\n- evalScript: ${output.value = "ok"}\n',
  );
  const host = createTestHostEnvironment({
    env: {
      AGENT_DEVICE_HOME: path.join(root, 'home'),
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
    },
  });
  return { root, entry, host, stateDir: path.join(root, 'state') };
}

async function trackedPlugin() {
  const resolved = await resolveProviderPlugins(await storePluginCandidates(process.env));
  const maestro = resolved.slots.find((slot) => slot.backend === 'maestro')?.replayPlugin;
  if (!maestro) throw new Error('Maestro test installation is missing');
  const calls = { setup: 0, create: 0, collect: 0, run: 0, dispose: 0 };
  const plugin: ReplayEnginePlugin = {
    ...maestro,
    setup: async (host) => {
      calls.setup += 1;
      const setup = await maestro.setup(host);
      if (!setup.replayBackend) throw new Error('Expected a format backend');
      const replayBackend = setup.replayBackend;
      return {
        replayBackend: {
          create: async (host) => {
            calls.create += 1;
            const backend = await replayBackend.create(host);
            return {
              ...backend,
              collectSourceFiles: (params) => {
                calls.collect += 1;
                return backend.collectSourceFiles(params);
              },
              runReplay: async (command) => {
                calls.run += 1;
                return await backend.runReplay(command);
              },
            };
          },
        },
        dispose: async () => {
          calls.dispose += 1;
          await setup.dispose?.();
        },
      };
    },
  };
  return { plugin, calls };
}

test.each(['replay', 'test', 'batch-test'] as const)(
  'the embedded client prepares %s includes with one runtime registry and an empty store',
  async (command) => {
    const state = createRuntimeStateHandle();
    try {
      await state.run(async () => {
        const f = fixture();
        const { plugin, calls } = await trackedPlugin();
        const host = await startAgentDevice({ ...f, plugins: [plugin] });
        const input = { path: f.entry, platform: 'ios' as const, backend: 'maestro' };
        const testInput = { paths: [f.entry], platform: 'ios' as const, backend: 'maestro' };
        try {
          expect(JSON.parse(JSON.stringify(host.clientConfig))).toEqual(host.clientConfig);
          if (command === 'replay') {
            await expect(host.client.replay.run(input)).resolves.toMatchObject({ replayed: 1 });
          } else if (command === 'test') {
            await expect(host.client.replay.test(testInput)).resolves.toMatchObject({
              passed: 1,
              failed: 0,
            });
          } else {
            await expect(
              host.client.batch.run({ steps: [{ command: 'test', input: testInput }] }),
            ).resolves.toMatchObject({
              executed: 1,
              results: [{ command: 'test', ok: true, data: { passed: 1, failed: 0 } }],
            });
          }
          expect(calls).toEqual({ setup: 1, create: 1, collect: 1, run: 1, dispose: 0 });
        } finally {
          await host.close();
        }
        expect(calls.dispose).toBe(1);
      });
    } finally {
      state.dispose();
    }
  },
);

test('isolated embedded clients ignore a conflicting store and never borrow another runtime backend', async () => {
  const f = fixture();
  const installation = crypto.randomUUID();
  const store = path.join(
    f.host.env.AGENT_DEVICE_HOME!,
    'plugins',
    installation,
    'node_modules',
    '@agent-device/maestro',
  );
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(
    path.join(store, 'package.json'),
    JSON.stringify({
      name: '@agent-device/maestro',
      version: '0.0.0',
      type: 'module',
      exports: { './agent-device': './plugin.mjs' },
    }),
  );
  fs.writeFileSync(
    path.join(store, 'plugin.mjs'),
    'throw new Error("conflicting store must not be loaded by embedded client");',
  );
  fs.writeFileSync(
    path.join(f.host.env.AGENT_DEVICE_HOME!, 'config.json'),
    JSON.stringify({ plugins: { '@agent-device/maestro': { installation } } }),
  );
  const firstPlugin = await trackedPlugin();
  const secondPlugin = await trackedPlugin();
  const first = await startAgentDevice({ ...f, plugins: [firstPlugin.plugin] });
  let second: Awaited<ReturnType<typeof startAgentDevice>> | undefined;
  try {
    second = await startAgentDevice({
      ...f,
      stateDir: path.join(f.root, 'second'),
      plugins: [secondPlugin.plugin],
    });
    await Promise.all(
      [first, second].map(async ({ client }) => {
        await expect(
          client.replay.run({ path: f.entry, backend: 'maestro', platform: 'ios' }),
        ).resolves.toMatchObject({ replayed: 1 });
      }),
    );
    for (const { calls } of [firstPlugin, secondPlugin]) {
      expect(calls).toEqual({ setup: 1, create: 1, collect: 1, run: 1, dispose: 0 });
    }
    // An outside attacher retains its own caller-side installation requirement.
    const outside = createAgentDeviceClient(first.clientConfig, { host: f.host });
    await expect(outside.replay.run({ path: f.entry, backend: 'maestro' })).rejects.toMatchObject({
      details: { reason: 'plugin_load_failed' },
    });
    await first.close();
    await expect(
      second.client.replay.run({ path: f.entry, backend: 'maestro', platform: 'ios' }),
    ).resolves.toMatchObject({ replayed: 1 });
    expect(firstPlugin.calls.dispose).toBe(1);
    expect(secondPlugin.calls.dispose).toBe(0);
  } finally {
    await first.close();
    await second?.close();
  }
  expect(secondPlugin.calls.dispose).toBe(1);
});

test('an embedded client without Maestro preserves the typed optional-plugin error', async () => {
  const f = fixture();
  const host = await startAgentDevice(f);
  try {
    await expect(
      host.client.replay.run({ path: f.entry, backend: 'maestro' }),
    ).rejects.toMatchObject({
      details: {
        reason: 'plugin-not-installed',
        package: '@agent-device/maestro',
        installCommand: 'agent-device plugins add @agent-device/maestro',
      },
    });
  } finally {
    await host.close();
  }
});
