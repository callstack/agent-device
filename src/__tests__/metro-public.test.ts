import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../metro/client-metro.ts', async () => {
  const actual = await vi.importActual<typeof import('../metro/client-metro.ts')>(
    '../metro/client-metro.ts',
  );
  return {
    ...actual,
    prepareMetroRuntime: vi.fn(),
    reloadMetro: vi.fn(),
  };
});

vi.mock('../metro/client-metro-companion.ts', () => ({
  ensureMetroCompanion: vi.fn(),
  stopMetroCompanion: vi.fn(),
}));

import { prepareMetroRuntime, reloadMetro } from '../metro/client-metro.ts';
import { ensureMetroCompanion, stopMetroCompanion } from '../metro/client-metro-companion.ts';
import {
  buildAndroidRuntimeHints,
  buildIosRuntimeHints,
  ensureMetroTunnel,
  prepareRemoteMetro,
  reloadRemoteMetro,
  resolveRuntimeTransport,
  stopMetroTunnel,
} from '../metro/metro.ts';

const TEST_BRIDGE_SCOPE = {
  tenantId: 'tenant-1',
  runId: 'run-1',
  leaseId: 'lease-1',
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

test('public metro helpers expose stable Node-facing wrappers', async () => {
  vi.mocked(prepareMetroRuntime).mockResolvedValue({
    projectRoot: '/tmp/project',
    kind: 'react-native',
    dependenciesInstalled: false,
    packageManager: null,
    started: false,
    reused: true,
    pid: 0,
    logPath: '/tmp/project/.agent-device/metro.log',
    statusUrl: 'http://127.0.0.1:8081/status',
    runtimeFilePath: null,
    iosRuntime: { platform: 'ios', bundleUrl: 'https://ios.example.test/index.bundle' },
    androidRuntime: {
      platform: 'android',
      bundleUrl: 'https://android.example.test/index.bundle',
    },
    bridge: null,
  });
  vi.mocked(ensureMetroCompanion).mockResolvedValue({
    pid: 123,
    spawned: true,
    statePath: '/tmp/project/.agent-device/metro-companion.json',
    logPath: '/tmp/project/.agent-device/metro-companion.log',
  });
  vi.mocked(stopMetroCompanion).mockResolvedValue({
    stopped: true,
    statePath: '/tmp/project/.agent-device/metro-companion.json',
  });
  vi.mocked(reloadMetro).mockResolvedValue({
    reloaded: true,
    reloadUrl: 'http://127.0.0.1:8081/reload',
    status: 200,
    body: 'OK',
  });

  const prepared = await prepareRemoteMetro({
    projectRoot: '/tmp/project',
    kind: 'react-native',
    publicBaseUrl: 'https://public.example.test',
    proxyBaseUrl: 'https://proxy.example.test',
    proxyBearerToken: 'token',
    bridgeScope: TEST_BRIDGE_SCOPE,
    profileKey: '/tmp/profile.remote.json',
    consumerKey: 'session-a',
    port: 8081,
  });
  const tunnel = await ensureMetroTunnel({
    projectRoot: '/tmp/project',
    serverBaseUrl: 'https://proxy.example.test',
    bearerToken: 'token',
    localBaseUrl: 'http://127.0.0.1:8081',
    bridgeScope: TEST_BRIDGE_SCOPE,
  });
  await stopMetroTunnel({
    projectRoot: '/tmp/project',
  });
  const reloaded = await reloadRemoteMetro({
    runtime: { platform: 'ios', bundleUrl: 'http://127.0.0.1:8081/index.bundle?platform=ios' },
  });

  assert.equal(prepared.reused, true);
  assert.equal(prepared.logPath, '/tmp/project/.agent-device/metro.log');
  assert.equal(tunnel.started, true);
  assert.equal(tunnel.logPath, '/tmp/project/.agent-device/metro-companion.log');
  assert.equal(reloaded.reloaded, true);
  assert.deepEqual(vi.mocked(prepareMetroRuntime).mock.calls[0]?.[0], {
    projectRoot: '/tmp/project',
    kind: 'react-native',
    publicBaseUrl: 'https://public.example.test',
    proxyBaseUrl: 'https://proxy.example.test',
    proxyBearerToken: 'token',
    bridgeScope: TEST_BRIDGE_SCOPE,
    launchUrl: undefined,
    companionProfileKey: '/tmp/profile.remote.json',
    companionConsumerKey: 'session-a',
    metroPort: 8081,
    listenHost: undefined,
    statusHost: undefined,
    startupTimeoutMs: undefined,
    probeTimeoutMs: undefined,
    reuseExisting: undefined,
    installDependenciesIfNeeded: undefined,
    runtimeFilePath: undefined,
    logPath: undefined,
    env: undefined,
  });
  assert.deepEqual(vi.mocked(reloadMetro).mock.calls[0]?.[0], {
    runtime: { platform: 'ios', bundleUrl: 'http://127.0.0.1:8081/index.bundle?platform=ios' },
  });
  assert.equal(
    buildIosRuntimeHints('https://public.example.test').bundleUrl,
    'https://public.example.test/index.bundle?platform=ios&dev=true&minify=false',
  );
  assert.equal(
    buildAndroidRuntimeHints('https://public.example.test').bundleUrl,
    'https://public.example.test/index.bundle?platform=android&dev=true&minify=false',
  );
  assert.deepEqual(
    resolveRuntimeTransport({
      platform: 'ios',
      bundleUrl: 'https://10.0.0.10:8082/index.bundle?platform=ios',
    }),
    {
      host: '10.0.0.10',
      port: 8082,
      scheme: 'https',
    },
  );
});
