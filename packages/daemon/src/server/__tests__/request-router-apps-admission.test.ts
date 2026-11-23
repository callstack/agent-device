import { expect, test, vi } from 'vitest';

import path from 'node:path';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

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
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    providerRuntimeIds: ['limrun', 'browserstack'],
    pluginInventory: [
      {
        source: 'store',
        provider: 'testmu',
        package: '@agent-device/testmu',
        state: 'dormant',
        dormant: {
          reason: 'test_credentials_missing',
          message: 'TestMu credentials are missing.',
          hint: 'Set LT_USERNAME and LT_ACCESS_KEY.',
        },
        credentials: { variables: ['LT_USERNAME', 'LT_ACCESS_KEY'], byBackend: {} },
      },
      {
        source: 'store',
        package: '@agent-device/maestro',
        state: 'failed',
        error: { code: 'INVALID_ARGS', message: 'Plugin failed to load' },
        credentials: { variables: [], byBackend: {} },
      },
    ],
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
    meta: {
      tenantId: 'tenant-a',
      runId: 'run-1',
      sessionIsolation: 'tenant',
      requestId: 'apps-admission',
    },
  };
}

test.each([
  ['bogus', 'unallocated'],
  ['browserstack', 'unallocated'],
  ['proxy', 'missing-lease'],
] as const)(
  'tenant apps rejects non-catalog provider %s as %s before provider or device access',
  async (leaseProvider, refusal) => {
    const { handler, listProviderApps, inspectFacts, bind } = createAppsAdmissionHarness(undefined);
    const response = await handler(appsRequest(leaseProvider));

    expect(response.ok).toBe(false);
    expect(response).toMatchObject(
      refusal === 'missing-lease'
        ? {
            ok: false,
            error: { code: 'INVALID_ARGS', message: 'tenant isolation requires lease id.' },
          }
        : {
            ok: false,
            error: {
              code: 'DEVICE_NOT_FOUND',
              details: { reason: 'provider_instance_unallocated' },
            },
          },
    );
    expect(listProviderApps).not.toHaveBeenCalled();
    expect(inspectFacts).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  },
);

test('tenant apps names the plugin when a managed provider is absent', async () => {
  const { handler, listProviderApps, inspectFacts, bind } = createAppsAdmissionHarness();
  const response = await handler(appsRequest('aws-device-farm'));

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      diagnosticId: expect.any(String),
      logPath: expect.stringContaining('apps-admission'),
      details: {
        reason: 'provider-not-registered',
        package: '@agent-device/aws-device-farm',
        installCommand: 'agent-device plugins add @agent-device/aws-device-farm@nightly-0.22',
      },
    },
  });
  expect(listProviderApps).not.toHaveBeenCalled();
  expect(inspectFacts).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
});

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

test('tenant apps reports the dormant provider prerequisite before device access', async () => {
  const { handler, listProviderApps, inspectFacts, bind } = createAppsAdmissionHarness();
  const response = await handler(appsRequest('testmu'));

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message: 'TestMu credentials are missing.',
      hint: 'Set LT_USERNAME and LT_ACCESS_KEY.',
      details: { provider: 'testmu', reason: 'test_credentials_missing' },
    },
  });
  expect(listProviderApps).not.toHaveBeenCalled();
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
