import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  webSessionBackendKey,
  webSessionDevice,
  type DeviceInfo,
  type WebSessionIdentity,
} from '@agent-device/kernel/device';
import {
  WEB_DESKTOP_DEVICE,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { replayScriptSourceBundleFor } from '../../__tests__/support/replay-script-source-fixture.ts';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { resolveRequestExecutionLockPlan } from '../request-binding.ts';

vi.mock('../../core/device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());

beforeEach(() => {
  mockResolveTargetDevice.mockReset();
});

const webSessionResolution = async (
  _flags: unknown,
  options?: { webSession?: WebSessionIdentity },
): Promise<DeviceInfo> =>
  options?.webSession
    ? webSessionDevice(WEB_DESKTOP_DEVICE, options.webSession)
    : WEB_DESKTOP_DEVICE;

function freshWebRequest(
  command: 'batch' | 'replay',
  session: string,
  replayPath: string,
): DaemonRequest {
  const flags =
    command === 'batch'
      ? {
          platform: 'web' as const,
          batchSteps: [{ command: 'open', positionals: ['about:blank'] }],
        }
      : { platform: 'web' as const, replayScriptSource: replayScriptSourceBundleFor(replayPath) };
  return {
    token: 'test-token',
    session,
    command,
    positionals: command === 'replay' ? [replayPath] : [],
    flags,
    meta: { requestId: `req-${command}-${session}`, sessionExplicit: true },
  };
}

test.each(['batch', 'replay'] as const)(
  'two fresh web %s requests of different sessions lock their own devices and run in parallel',
  async (command) => {
    mockResolveTargetDevice.mockImplementation(webSessionResolution);
    const root = mkdtempForTestSync('agent-device-router-web-parallel-');
    const replayPath = path.join(root, 'flow.ad');
    fs.writeFileSync(replayPath, 'context platform=web\nopen about:blank\n');
    const claimsDir = mkdtempForTestSync('agent-device-router-web-parallel-claims-');
    vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', claimsDir);
    const sessionStore = makeSessionStore('agent-device-router-web-parallel-');
    try {
      const names = ['web-a', 'web-b'];
      for (const name of names) {
        const { keys } = await resolveRequestExecutionLockPlan({
          req: freshWebRequest(command, name, replayPath),
          sessionName: name,
          sessionStore,
        });
        expect(keys).toEqual([
          `session:${name}`,
          `device:${WEB_DESKTOP_DEVICE.id}:session:p_${name}`,
        ]);
      }

      // A run binds its device while it holds its locks and waits there until the other session
      // has bound its own: a run that held the shared host device would keep the other from
      // starting, and neither would finish.
      const bound = new Set<string>();
      let bothBound!: () => void;
      const both = new Promise<void>((resolve) => (bothBound = resolve));
      const handler = createRequestHandler({
        host: createTestHostEnvironment(),
        createCommandSurface: fakeCreateCommandSurface,
        logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
        token: 'test-token',
        sessionStore,
        leaseRegistry: new LeaseRegistry(),
        deviceRuntimeGateway: {
          ...lifecycleDeviceRuntimeGateway,
          bind: async (request) => {
            bound.add(request.device.id);
            if (bound.size >= names.length) bothBound();
            await both;
            return await lifecycleDeviceRuntimeGateway.bind(request);
          },
        },
        deviceInventoryGateways: createTestDeviceInventoryGateways(),
        trackDownloadableArtifact: () => 'artifact-id',
      });
      const pending = names.map((name) => handler(freshWebRequest(command, name, replayPath)));
      // A request that ends before it binds releases the other one's wait, so its failure reaches
      // the assertions below instead of hanging the test.
      for (const response of pending) response.then(bothBound, bothBound);
      const responses = await Promise.all(pending);

      for (const response of responses) expect(response).toMatchObject({ ok: true });
      expect([...bound].sort()).toEqual(
        names.map((name) => `${WEB_DESKTOP_DEVICE.id}:session:p_${name}`),
      );
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(claimsDir, { recursive: true, force: true });
    }
  },
);

function createOpenHandler(
  sessionStore: ReturnType<typeof makeSessionStore>,
  leaseRegistry = new LeaseRegistry(),
) {
  return createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

function openWebRequest(session: string): DaemonRequest {
  return {
    token: 'test-token',
    session,
    command: 'open',
    positionals: ['about:blank'],
    flags: { platform: 'web' },
    meta: { requestId: `req-open-${JSON.stringify(session)}` },
  };
}

test.each(['', '   '])(
  'a fresh web open with the blank session name %j is refused and opens no browser',
  async (session) => {
    mockResolveTargetDevice.mockImplementation(webSessionResolution);
    const sessionStore = makeSessionStore('agent-device-router-web-blank-');

    const response = await createOpenHandler(sessionStore)(openWebRequest(session));

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGS', details: { reason: 'web_session_name_invalid' } },
    });
    expect(sessionStore.toArray()).toEqual([]);
  },
);

test('an open with an empty session name does not reopen the default web session', async () => {
  mockResolveTargetDevice.mockImplementation(webSessionResolution);
  const sessionStore = makeSessionStore('agent-device-router-web-blank-reuse-');
  sessionStore.publish(
    'default',
    makeSession('default', { device: webSessionDevice(WEB_DESKTOP_DEVICE, { name: 'default' }) }),
  );

  const response = await createOpenHandler(sessionStore)(openWebRequest(''));

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', details: { reason: 'web_session_name_invalid' } },
  });
  expect(sessionStore.get('default')?.actions).toEqual([]);
});

test('two tenants using one web session name each open their own browser, and one tenant conflicts with itself', async () => {
  mockResolveTargetDevice.mockImplementation(webSessionResolution);
  const claimsDir = mkdtempForTestSync('agent-device-router-web-tenant-claims-');
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', claimsDir);
  const sessionStore = makeSessionStore('agent-device-router-web-tenant-');
  const leaseRegistry = new LeaseRegistry();
  const handler = createOpenHandler(sessionStore, leaseRegistry);
  // Web is admitted under a lease of any other backend: admission does not compare the two.
  const leases = new Map(
    ['tenant-1', 'tenant-2'].map((tenantId) => [
      tenantId,
      leaseRegistry.allocateLease({ tenantId, runId: 'run-1', leaseBackend: 'ios-simulator' }),
    ]),
  );
  const tenantOpen = (tenantId: string, name: string, leaseId = leases.get(tenantId)!.leaseId) => ({
    ...openWebRequest(name),
    meta: {
      requestId: `req-open-${tenantId}-${name}`,
      tenantId,
      runId: 'run-1',
      leaseId,
      leaseBackend: 'ios-simulator' as const,
      sessionIsolation: 'tenant' as const,
    },
  });
  const deviceId = (tenantId: string, name: string) =>
    `${WEB_DESKTOP_DEVICE.id}:session:${webSessionBackendKey({ name, tenantId })}`;
  try {
    const [first, second] = await Promise.all([
      handler(tenantOpen('tenant-1', 'shop')),
      handler(tenantOpen('tenant-2', 'shop')),
    ]);

    expect(first).toMatchObject({ ok: true, data: { id: deviceId('tenant-1', 'shop') } });
    expect(second).toMatchObject({ ok: true, data: { id: deviceId('tenant-2', 'shop') } });
    expect(deviceId('tenant-1', 'shop')).not.toBe(deviceId('tenant-2', 'shop'));
    expect(sessionStore.get('tenant-1:shop')?.device.id).toBe(deviceId('tenant-1', 'shop'));
    expect(sessionStore.get('tenant-2:shop')?.device.id).toBe(deviceId('tenant-2', 'shop'));

    // Another daemon on the host shares the claims: the same tenant and name is refused, and
    // another name under the same tenant opens beside it.
    const foreignLeases = new LeaseRegistry();
    for (const [tenantId, lease] of leases) {
      foreignLeases.allocateLease({
        tenantId,
        runId: 'run-1',
        leaseBackend: 'ios-simulator',
        leaseId: lease.leaseId,
      });
    }
    const foreign = createOpenHandler(
      makeSessionStore('agent-device-router-web-tenant-foreign-'),
      foreignLeases,
    );
    expect(await foreign(tenantOpen('tenant-1', 'shop'))).toMatchObject({
      ok: false,
      error: { code: 'DEVICE_IN_USE' },
    });
    expect(await foreign(tenantOpen('tenant-1', 'cart'))).toMatchObject({
      ok: true,
      data: { id: deviceId('tenant-1', 'cart') },
    });
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});
