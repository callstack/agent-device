import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createDaemonProxyServer } from '@agent-device/proxy';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createDaemonHttpServer } from './http-server.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeIosAppSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { tenantScopedSessionName } from '../../core/session-tenant-scope.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';

// One proxy token for every client, as an integrator that runs many sandboxes behind one proxy has.
const PROXY_TOKEN = 'shared-proxy-token';
const TENANT = 'e2b';
const SESSION = 'agentA';
const OWNER_SCOPE = {
  tenantId: TENANT,
  runId: 'run-a',
  leaseProvider: 'proxy',
  clientId: 'client-a',
  deviceKey: 'ios:mobile:SIM-001',
} as const;

type RpcBody = {
  result?: { ok?: boolean };
  error?: { data?: { code?: string; details?: { reason?: string; field?: string } } };
};

let world: Awaited<ReturnType<typeof startProxiedDaemon>> | undefined;

beforeEach(async (context) => {
  if (await skipWhenLoopbackUnavailable(context)) return;
  world = await startProxiedDaemon();
});

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function startProxiedDaemon() {
  const sessionStore = makeSessionStore('agent-device-proxy-session-lease-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({ ...OWNER_SCOPE, leaseBackend: 'ios-instance' });
  const sessionName = tenantScopedSessionName(TENANT, SESSION);
  sessionStore.publish(
    sessionName,
    makeIosAppSession(sessionName, {
      sessionScope: { kind: 'tenant', id: TENANT },
      lease: {
        leaseId: lease.leaseId,
        tenantId: TENANT,
        runId: OWNER_SCOPE.runId,
        leaseBackend: lease.backend,
        leaseProvider: OWNER_SCOPE.leaseProvider,
        clientId: OWNER_SCOPE.clientId,
        deviceKey: OWNER_SCOPE.deviceKey,
      },
    }),
  );
  const handleRequest = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('agent-device-proxy-session-lease-log-'), 'daemon.log'),
    token: 'daemon-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  const daemon = await createDaemonHttpServer({
    token: 'daemon-token',
    handleRequest,
    env: {},
    cwd: process.cwd(),
  });
  const daemonPort = await listenOnLoopback(daemon);
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${daemonPort}`,
    upstreamToken: 'daemon-token',
    clientToken: PROXY_TOKEN,
  });
  const proxyPort = await listenOnLoopback(proxy);
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/agent-device/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PROXY_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    });
    return (await response.json()) as RpcBody;
  };
  return {
    leaseId: lease.leaseId,
    sessionName,
    sessionStore,
    leaseRegistry,
    rpc,
    send: async (command: string, positionals: string[], meta: Record<string, unknown>) =>
      await rpc('agent_device.command', {
        session: SESSION,
        command,
        positionals,
        flags: {},
        meta: { tenantId: TENANT, sessionIsolation: 'tenant', sessionExplicit: true, ...meta },
      }),
    close: async () => {
      await closeLoopbackServer(proxy);
      await closeLoopbackServer(daemon);
    },
  };
}

function expectLeaseFieldRefusal(body: RpcBody, field: string): void {
  expect(body.error?.data, JSON.stringify(body)).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'LEASE_SESSION_MISMATCH', field },
  });
}

function expectLeaseIdRefusal(body: RpcBody): void {
  expect(body.error?.data, JSON.stringify(body)).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'LEASE_SESSION_MISMATCH', field: 'leaseId' },
  });
}

test.each([
  ['read the screen', 'snapshot', []],
  ['drive the device', 'press', ['@e7']],
  ['close the session', 'close', []],
  ['list the cloud artifacts', 'artifacts', []],
])(
  'a client with the proxy token and session name but no lease id cannot %s',
  async (_action, command, positionals) => {
    if (!world) return;
    const heartbeatAt = world.leaseRegistry.listActiveLeases()[0]?.heartbeatAt;

    expectLeaseIdRefusal(await world.send(command, positionals, {}));

    expect(world.sessionStore.get(world.sessionName)?.lease?.leaseId).toBe(world.leaseId);
    expect(world.leaseRegistry.listActiveLeases()[0]?.heartbeatAt).toBe(heartbeatAt);
  },
);

test('a client that copies the owner labels but not the lease id is refused', async () => {
  if (!world) return;

  expectLeaseIdRefusal(await world.send('snapshot', [], { ...OWNER_SCOPE }));
});

test('the owner that sends the lease id reads and closes its session through the proxy', async () => {
  if (!world) return;
  const owner = { ...OWNER_SCOPE, leaseId: world.leaseId };

  const snapshot = await world.send('snapshot', [], owner);
  expect(snapshot.result?.ok, JSON.stringify(snapshot)).toBe(true);

  const closed = await world.send('close', [], owner);
  expect(closed.result?.ok, JSON.stringify(closed)).toBe(true);
  expect(world.sessionStore.get(world.sessionName)).toBeUndefined();
});

test('install_from_source on a leased session needs the lease id in its params', async () => {
  if (!world) return;
  const install = {
    session: world.sessionName,
    platform: 'ios',
    source: { kind: 'url', url: 'http://127.0.0.1:9/app.zip' },
  };

  expectLeaseIdRefusal(await world.rpc('agent_device.install_from_source', install));

  const owner = await world.rpc('agent_device.install_from_source', {
    ...install,
    ...OWNER_SCOPE,
    leaseId: world.leaseId,
  });
  // Admitted: it reaches the device runtime, which this fake device does not implement.
  expect(owner.error?.data?.code, JSON.stringify(owner)).toBe('UNSUPPORTED_OPERATION');
  expectLeaseFieldRefusal(
    await world.rpc('agent_device.install_from_source', {
      ...install,
      ...OWNER_SCOPE,
      runId: 'run-other',
      leaseId: world.leaseId,
    }),
    'runId',
  );
  expectLeaseFieldRefusal(
    await world.rpc('agent_device.install_from_source', {
      ...install,
      ...OWNER_SCOPE,
      leaseBackend: 'android-instance',
      leaseId: world.leaseId,
    }),
    'leaseBackend',
  );
});

test('an open of an existing leased session checks the lease id before the proxy metadata', async () => {
  if (!world) return;

  expectLeaseIdRefusal(await world.send('open', ['com.example.app'], { ...OWNER_SCOPE }));

  const { clientId: _omitted, ...ownerWithoutClient } = OWNER_SCOPE;
  const reopened = await world.send('open', ['com.example.app'], {
    ...ownerWithoutClient,
    leaseId: world.leaseId,
  });
  expect(reopened.error?.data?.code, JSON.stringify(reopened)).not.toBe('INVALID_ARGS');
  expect(reopened.error?.data?.code, JSON.stringify(reopened)).not.toBe('UNAUTHORIZED');
});
