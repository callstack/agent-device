import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { MACOS_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeMacOsSession } from '../../__tests__/test-utils/session-factories.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';
import { screenshotRuntimeFixture } from './screenshot-runtime-fixture.ts';

const BUNDLE_ID = 'com.example.leased';
const LEASE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LEASE_META = {
  tenantId: 'tenant-a',
  runId: 'run-1',
  leaseId: LEASE_ID,
  sessionIsolation: 'tenant',
  leaseProvider: 'proxy',
  clientId: 'client-a',
  deviceKey: BUNDLE_ID,
  leaseBackend: 'macos-app',
} as const;

beforeEach(() => {
  vi.stubEnv('AGENT_DEVICE_MACOS_APP_BACKEND', 'native');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function leasedRouter() {
  const sessionStore = makeSessionStore('agent-device-router-macos-app-lease-');
  sessionStore.publish(
    'tenant-a:default',
    makeMacOsSession('tenant-a:default', {
      appBundleId: BUNDLE_ID,
      surface: 'app',
      sessionScope: { kind: 'tenant', id: 'tenant-a' },
    }),
  );
  const leaseRegistry = new LeaseRegistry();
  leaseRegistry.putHostLease(LEASE_ID, {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    leaseBackend: 'macos-app',
    deviceKey: BUNDLE_ID,
  });
  const runtime = screenshotRuntimeFixture();
  const handler = createRequestHandler({
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { handler, sessionStore };
}

function leasedRequest(command: string, requestId: string, extra: Partial<DaemonRequest> = {}) {
  return {
    token: 'test-token',
    session: 'default',
    command,
    positionals: [],
    flags: { platform: 'macos' },
    meta: { requestId, ...LEASE_META },
    ...extra,
  } as DaemonRequest;
}

function hostFacts(sessionStore: ReturnType<typeof makeSessionStore>): string[] {
  return [sessionStore.resolveDaemonStateDir(), MACOS_DEVICE.name];
}

function expectNoHostFacts(response: DaemonResponse, facts: string[]): void {
  const wire = JSON.stringify(response);
  for (const fact of facts) expect(wire).not.toContain(fact);
  expect(wire).not.toContain('logPath');
  expect(wire).not.toContain('diagnosticsRecord');
}

test('a leased screenshot answers with the artifact handle and the tenant-chosen path only', async () => {
  const { handler, sessionStore } = leasedRouter();
  const remotePath = '/tmp/agent-device-screenshot-1700000000000-abc123.png';

  const response = await handler(
    leasedRequest('screenshot', 'req-shot', { positionals: [remotePath] }),
  );

  expect(response).toMatchObject({ ok: true, data: { path: remotePath } });
  expectNoHostFacts(response, hostFacts(sessionStore));
});

test('a refused leased request names no host log or path', async () => {
  const { handler, sessionStore } = leasedRouter();

  const response = await handler(leasedRequest('devices', 'req-devices'));

  expect(response).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  expectNoHostFacts(response, hostFacts(sessionStore));
});

test('a leased snapshot carries the app tree and nothing about the host', async () => {
  const { handler, sessionStore } = leasedRouter();

  const response = await handler(leasedRequest('snapshot', 'req-snapshot'));

  expect(response.ok).toBe(true);
  expectNoHostFacts(response, hostFacts(sessionStore));
});

test('a request without a macos-app lease keeps its log locators', async () => {
  const sessionStore = makeSessionStore('agent-device-router-unleased-');
  const handler = createRequestHandler({
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: screenshotRuntimeFixture().gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: {},
    meta: { requestId: 'req-unleased' },
  });

  expect(response).toMatchObject({
    ok: false,
    error: { logPath: expect.stringContaining(sessionStore.resolveDaemonStateDir()) },
  });
});
