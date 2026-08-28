import { expect, test, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import type { DaemonRequest } from '../types.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';

function createAppsAdmissionHarness(apps: readonly string[] = []) {
  const listProviderApps = vi.fn(async () => apps);
  const providerAppCatalog = {
    supports: vi.fn((provider: string) => provider === 'limrun'),
    list: listProviderApps,
  };
  const inspectFacts = vi.fn(async () => {
    throw new Error('apps catalog must not inspect device facts');
  });
  const bind = vi.fn(async () => {
    throw new Error('apps catalog must not bind a device');
  });
  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore: makeSessionStore('agent-device-apps-admission-'),
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: {
      inspectFacts,
      bind,
      shutdown: async () => {},
    } satisfies DeviceRuntimeGateway<PlatformRuntimeOperations>,
    providerAppCatalog,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { handler, listProviderApps, inspectFacts, bind };
}

function appsRequest(leaseProvider: string): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command: 'apps',
    positionals: [],
    flags: { platform: 'ios', leaseProvider },
    meta: { tenantId: 'tenant-a', runId: 'run-1', sessionIsolation: 'tenant' },
  };
}

test.each(['bogus', 'proxy', 'browserstack'])(
  'tenant apps rejects non-catalog provider %s before provider or device access',
  async (leaseProvider) => {
    const { handler, listProviderApps, inspectFacts, bind } = createAppsAdmissionHarness(undefined);
    const response = await handler(appsRequest(leaseProvider));

    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error.message).toMatch(
      /tenant isolation requires lease id/,
    );
    expect(listProviderApps).not.toHaveBeenCalled();
    expect(inspectFacts).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  },
);

test('tenant apps admits the runtime-declared catalog provider without device access', async () => {
  const { handler, listProviderApps, inspectFacts, bind } = createAppsAdmissionHarness([
    'Example.app.zip',
  ]);
  const response = await handler(appsRequest('limrun'));

  expect(response).toEqual({ ok: true, data: { apps: ['Example.app.zip'] } });
  expect(listProviderApps).toHaveBeenCalledTimes(1);
  expect(inspectFacts).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
});

test('tenant apps treats an empty provider catalog as authoritative', async () => {
  const { handler, listProviderApps, inspectFacts, bind } = createAppsAdmissionHarness();
  const response = await handler(appsRequest('limrun'));

  expect(response).toEqual({ ok: true, data: { apps: [] } });
  expect(listProviderApps).toHaveBeenCalledTimes(1);
  expect(inspectFacts).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
});
