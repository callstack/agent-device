import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { startDaemonRuntime } from '@agent-device/daemon';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createLimrunRuntime } from '@agent-device/provider-limrun';
import {
  DAEMON_HTTP_NETWORK_ACCESS_HEADER,
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
} from '@agent-device/contracts/daemon-http';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';
import { limrunTestDependencies } from './platform-runtime-gateway.fixtures.ts';

const limrunIo = vi.hoisted(() => ({
  listAssets: vi.fn(),
  createAndroidInstance: vi.fn(),
}));
const rootPorts = vi.hoisted(() => {
  const applicationLifecycle = {
    recoverStartupResources: vi.fn(async () => {}),
    detachForDaemonShutdown: vi.fn(async () => []),
    finalizeDaemonShutdown: vi.fn(async () => []),
  };
  return {
    providerComposition: vi.fn(async () => ({
      runtimes: [] as unknown[],
      platformModules: [] as unknown[],
      inventory: [] as unknown[],
      shutdown: async () => [],
    })),
    createPlatformRuntimeGateway: vi.fn(() => ({
      applicationLifecycle,
      inspectFacts: async () => {
        throw new Error('unused');
      },
      bind: async () => {
        throw new Error('unused');
      },
      shutdown: vi.fn(async () => {}),
    })),
    createPlatformDeviceInventoryGateways: vi.fn(async () => ({})),
    createRequestPlatformProviders: vi.fn(() => ({
      run: async (_context: unknown, task: () => Promise<unknown>) => await task(),
    })),
    applicationLifecycle,
  };
});

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly assets = { list: limrunIo.listAssets };
    readonly androidInstances = {
      create: limrunIo.createAndroidInstance,
      delete: vi.fn(),
      list: vi.fn(),
    };
    readonly iosInstances = { create: vi.fn(), delete: vi.fn(), list: vi.fn() };
  },
}));

vi.mock('./platform-runtime.ts', () => ({
  androidObservation: {},
  createPlatformRuntimeGateway: rootPorts.createPlatformRuntimeGateway,
  createPlatformDeviceInventoryGateways: rootPorts.createPlatformDeviceInventoryGateways,
  createRequestPlatformProviders: rootPorts.createRequestPlatformProviders,
}));

vi.mock('./provider-device-runtimes.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider-device-runtimes.ts')>();
  return {
    ...actual,
    createDaemonProviderRuntimeComposition: rootPorts.providerComposition,
  };
});

test('public HTTP rejects Limrun uploaded-app listing and allocation before provider I/O', async () => {
  const stateDir = mkdtempForTestSync('agent-device-limrun-http-access-');
  const paths = resolveDaemonPaths(stateDir);
  const limrun = createLimrunRuntime(
    { apiKey: 'lim_test_key', runtimeInstance: 'http-access-test' },
    limrunTestDependencies,
  );
  rootPorts.providerComposition.mockResolvedValue({
    runtimes: [limrun],
    platformModules: [],
    inventory: [],
    shutdown: async () => {
      await limrun.shutdown();
      return [];
    },
  });
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> | undefined;

  try {
    runtime = await startDaemonRuntime({
      composeDeps: createDaemonRuntimeDeps,
      host: createTestHostEnvironment({
        env: {
          ...process.env,
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
          LIM_ANDROID_INSTANCE_URL: 'https://region.limrun.example/v1/android_test/api',
          LIM_ANDROID_INSTANCE_TOKEN: 'lim-test-token',
          LIM_ANDROID_INSTANCE_ADB_URL: 'https://region.limrun.example/v1/android_test/adb',
        },
      }),
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    const activeRuntime = runtime;
    if (!activeRuntime?.httpPort) throw new Error('HTTP daemon runtime did not start');
    limrunIo.listAssets.mockClear();
    limrunIo.createAndroidInstance.mockClear();

    const callRpc = async (payload: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${activeRuntime.httpPort}/rpc`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${activeRuntime.token}`,
          'content-type': 'application/json',
          [DAEMON_HTTP_NETWORK_ACCESS_HEADER]: DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
        },
        body: JSON.stringify(payload),
      });
      return (await response.json()) as { error?: { data?: { code?: string } } };
    };

    const apps = await callRpc({
      jsonrpc: '2.0',
      id: 'limrun-public-apps',
      method: 'agent_device.command',
      params: {
        command: 'apps',
        positionals: [],
        flags: { platform: 'android', leaseProvider: 'limrun' },
      },
    });
    const allocation = await callRpc({
      jsonrpc: '2.0',
      id: 'limrun-public-allocation',
      method: 'agent_device.lease.allocate',
      params: {
        tenantId: 'tenant-a',
        runId: 'run-a',
        backend: 'android-instance',
        leaseProvider: 'limrun',
        providerApp: 'Example.apk',
      },
    });

    assert.equal(apps.error?.data?.code, 'UNAUTHORIZED');
    assert.equal(allocation.error?.data?.code, 'UNAUTHORIZED');
    assert.equal(limrunIo.listAssets.mock.calls.length, 0);
    assert.equal(limrunIo.createAndroidInstance.mock.calls.length, 0);
    assert.equal(rootPorts.providerComposition.mock.calls.length, 1);
    assert.equal(rootPorts.createPlatformRuntimeGateway.mock.calls.length, 1);
    assert.equal(rootPorts.createPlatformDeviceInventoryGateways.mock.calls.length, 1);
    assert.equal(rootPorts.createRequestPlatformProviders.mock.calls.length, 1);
    assert.equal(rootPorts.applicationLifecycle.recoverStartupResources.mock.calls.length, 1);
  } finally {
    await runtime?.close();
    await limrun.shutdown();
    fs.rmSync(paths.baseDir, { recursive: true, force: true });
    if (runtime)
      assert.equal(rootPorts.applicationLifecycle.finalizeDaemonShutdown.mock.calls.length, 1);
  }
});
