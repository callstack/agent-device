import { createPluginSelectionGuard } from '@agent-device/plugins/store';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { bindReplayBackendResolver } from '@agent-device/replay-port/replay-backend-registry';
import { resolveProviderPlugins, startProviderRegistry } from '@agent-device/plugins/registry';
import {
  selectV2Plugin,
  mkdtempForTestSync,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

async function fixture(storeEnv?: NodeJS.ProcessEnv) {
  const root = mkdtempForTestSync('replay-plugin-admission-');
  const discover = vi.fn(async () => []);
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([]),
    {},
    {
      assertReplaySelectionCurrent: storeEnv ? createPluginSelectionGuard([], storeEnv) : undefined,
      adaptWebDriver: async () => {
        throw new Error('no provider');
      },
    },
  );
  await bindReplayBackendResolver(registry.resolveReplayBackend, registry.resolveReplayExecution);
  const store = makeSessionStore('replay-plugin-admission-store-');
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(root, 'daemon.log'),
    token: 'token',
    sessionStore: store,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways({ local: discover }),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { registry, discover, handler, store };
}

const source = {
  entry: '/caller/flow.ad',
  files: { '/caller/flow.ad': 'open com.example.app\nclose\n' },
};

test.each(['yaml', 'yml'])(
  'bare %s replay reports explicit routing before plugin or device admission',
  async (extension) => {
    const f = await fixture();
    const entry = `/caller/flow.${extension}`;
    try {
      const result = await f.handler({
        token: 'token',
        command: 'replay',
        session: 'untouched',
        positionals: [entry],
        flags: { replayScriptSource: { entry, files: { [entry]: 'appId: com.example.app' } } },
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_ARGS',
          message: `Maestro YAML requires explicit --maestro routing: replay ${entry} --maestro`,
        },
      });
      if (result.ok) throw new Error('Bare YAML replay succeeded');
      expect(result.error.details?.installCommand).toBeUndefined();
      expect(f.discover).not.toHaveBeenCalled();
      expect(f.store.get('untouched')).toBeUndefined();
    } finally {
      await f.registry.close();
    }
  },
);

test.each(['replay', 'test'] as const)(
  'missing %s execution is classified before device selection',
  async (command) => {
    const f = await fixture();
    try {
      const result = await f.handler({
        token: 'token',
        command,
        session: 'untouched',
        positionals: [source.entry],
        flags: { platform: 'ios', replayScriptSource: source, replayScriptSources: [source] },
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_ARGS',
          details: {
            reason: 'plugin-not-installed',
            package: '@agent-device/replay',
            installCommand: 'agent-device plugins add @agent-device/replay',
          },
        },
      });
      expect(f.discover).not.toHaveBeenCalled();
      expect(f.store.get('untouched')).toBeUndefined();
    } finally {
      await f.registry.close();
    }
  },
);

test('explicit Maestro routing still admits only the Maestro plugin', async () => {
  const f = await fixture();
  const entry = '/caller/flow.yaml';
  try {
    const result = await f.handler({
      token: 'token',
      command: 'replay',
      session: 'untouched',
      positionals: [entry],
      flags: {
        replayBackend: 'maestro',
        replayScriptSource: { entry, files: { [entry]: 'appId: com.example.app' } },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { details: { reason: 'plugin-not-installed', package: '@agent-device/maestro' } },
    });
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.store.get('untouched')).toBeUndefined();
  } finally {
    await f.registry.close();
  }
});

test('a changed store needs a daemon restart and embedded runtimes never consult it', async () => {
  const home = mkdtempForTestSync('replay-plugin-store-');
  const env = { AGENT_DEVICE_HOME: home };
  const f = await fixture(env);
  try {
    selectV2Plugin(
      home,
      '@agent-device/replay',
      'throw new Error("must not import while detecting stale daemon");',
    );
    const request = {
      token: 'token',
      command: 'replay',
      session: 'untouched',
      positionals: [source.entry],
      flags: { replayScriptSource: source },
    };
    expect(await f.handler(request)).toMatchObject({
      ok: false,
      error: { details: { reason: 'daemon-plugin-set-stale' } },
    });
    const embedded = await fixture();
    try {
      expect(await embedded.handler(request)).toMatchObject({
        ok: false,
        error: { details: { reason: 'plugin-not-installed' } },
      });
      expect(embedded.discover).not.toHaveBeenCalled();
    } finally {
      await embedded.registry.close();
    }
    expect(f.discover).not.toHaveBeenCalled();
  } finally {
    await f.registry.close();
  }
});

test.each(['unknown-engine', ''])(
  'backend %j receives no inferred installation command',
  async (backend) => {
    const f = await fixture();
    try {
      const result = await f.handler({
        token: 'token',
        command: 'replay',
        session: 'untouched',
        positionals: [source.entry],
        flags: { replayBackend: backend, replayScriptSource: source },
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
      if (result.ok) throw new Error('Unknown backend succeeded');
      expect(result.error.details?.installCommand).toBeUndefined();
      expect(result.error.message).toContain('Unsupported replay backend');
      expect(f.discover).not.toHaveBeenCalled();
    } finally {
      await f.registry.close();
    }
  },
);
