import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';
import { createLimrunRuntime } from '@agent-device/provider-limrun';
import { createProviderDeviceRuntimeRequestProviders } from '../../provider-device-runtime.ts';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { limrunTestDependencies } from '../../platform-runtime-gateway.fixtures.ts';
import {
  DAEMON_HTTP_NETWORK_ACCESS_HEADER,
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
} from '../http-contract.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createDaemonHttpServer } from '../server/http-server.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';

const limrunIo = vi.hoisted(() => ({
  listAssets: vi.fn(),
  createAndroidInstance: vi.fn(),
}));

type RpcResponse = { error?: { data?: { code?: string } } };

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

test('public HTTP rejects Limrun uploaded-app listing and allocation before provider I/O', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  limrunIo.listAssets.mockClear();
  limrunIo.createAndroidInstance.mockClear();
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', runtimeInstance: 'http-access-test' },
    limrunTestDependencies,
  );
  const providers = createProviderDeviceRuntimeRequestProviders([runtime]);
  const token = 'limrun-http-test-token';
  const leaseRegistry = new LeaseRegistry();
  const handleRequest = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'agent-device-limrun-http-access.log'),
    token,
    sessionStore: makeSessionStore('agent-device-limrun-http-access-'),
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    providerRuntimeIds: providers.providerRuntimeIds,
    providerRuntimeRequiredIds: providers.providerRuntimeRequiredIds,
    leaseLifecycleProvider: providers.leaseLifecycleProvider,
    providerAppCatalog: providers.providerAppCatalog,
    providerDeviceRuntimeScope: providers.providerDeviceRuntimeScope,
    trackDownloadableArtifact: () => 'unused-artifact',
  });
  const server = await createDaemonHttpServer({ token, leaseRegistry, handleRequest });

  try {
    const port = await listenOnLoopback(server);
    const apps = await callRpc(port, token, {
      jsonrpc: '2.0',
      id: 'limrun-public-apps',
      method: 'agent_device.command',
      params: {
        command: 'apps',
        positionals: [],
        flags: { platform: 'android', leaseProvider: 'limrun' },
      },
    });
    const allocation = await callRpc(port, token, {
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
  } finally {
    await closeLoopbackServer(server);
    await runtime.shutdown();
  }
});

async function callRpc(
  port: number,
  token: string,
  payload: Record<string, unknown>,
): Promise<RpcResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      [DAEMON_HTTP_NETWORK_ACCESS_HEADER]: DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
    },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as RpcResponse;
}
