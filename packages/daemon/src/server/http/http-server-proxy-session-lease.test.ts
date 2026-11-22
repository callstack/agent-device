import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDaemonProxyServer } from '@agent-device/proxy';
import {
  IOS_SIMULATOR,
  closeLoopbackServer,
  createTestHostEnvironment,
  deviceClaimFilePath,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { acquireDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createDaemonHttpServer } from './http-server.ts';
import { createSocketServer, listenNetServer } from './transport.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeIosAppSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { retainOrphanedDeviceClaims } from '../../__tests__/support/device-claim-store.ts';
import { tenantScopedSessionName } from '../../core/session-tenant-scope.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { getLeaseRegistryExecutionLocks } from '../request-execution-scope.ts';
import { resolveSessionIdleExpiryMs } from '../session-idle-expiry.ts';
import { createSessionIdleExpiry } from './daemon-session-idle-expiry.ts';

// One proxy token for every client, as an integrator that runs many sandboxes behind one proxy has.
const PROXY_TOKEN = 'shared-proxy-token';
const TENANT = 'e2b';
const SESSION = 'agentA';
const OWNER_SCOPE = {
  tenantId: TENANT,
  runId: 'run-a',
  leaseProvider: 'proxy',
  clientId: 'client-a',
  deviceKey: `ios:mobile:${IOS_SIMULATOR.id}`,
} as const;

type RpcError = { code?: string; details?: { reason?: string; field?: string } };
type RpcBody = {
  result?: { ok?: boolean; data?: { sessions?: { address?: string }[] } };
  error?: { data?: RpcError };
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

async function startProxiedDaemon(
  options: { env?: NodeJS.ProcessEnv; openSession?: boolean } = {},
) {
  const sessionStore = makeSessionStore('agent-device-proxy-session-lease-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({ ...OWNER_SCOPE, leaseBackend: 'ios-instance' });
  const sessionName = tenantScopedSessionName(TENANT, SESSION);
  if (options.openSession !== false) {
    sessionStore.publish(
      sessionName,
      makeIosAppSession(sessionName, {
        sessionScope: { kind: 'tenant', id: TENANT },
        lease: {
          leaseId: lease.leaseId,
          tenantId: TENANT,
          runId: OWNER_SCOPE.runId,
          backend: lease.backend,
          leaseProvider: OWNER_SCOPE.leaseProvider,
          clientId: OWNER_SCOPE.clientId,
          deviceKey: OWNER_SCOPE.deviceKey,
        },
      }),
    );
  }
  const handleRequest = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('agent-device-proxy-session-lease-log-'), 'daemon.log'),
    token: 'daemon-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => [IOS_SIMULATOR],
    }),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  const daemon = await createDaemonHttpServer({
    token: 'daemon-token',
    handleRequest,
    env: options.env ?? {},
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
  // The local socket runs no HTTP intake, so nothing has recorded a displaced tenant before routing.
  const socketServer = createSocketServer(handleRequest);
  const socketPort = await listenNetServer(socketServer);
  const socket = async (request: Record<string, unknown>) =>
    await new Promise<RpcBody>((resolve, reject) => {
      const connection = net.createConnection({ host: '127.0.0.1', port: socketPort });
      let buffer = '';
      connection.setEncoding('utf8');
      connection.once('error', reject);
      connection.on('data', (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        connection.destroy();
        const response = JSON.parse(buffer) as { ok: boolean; error?: RpcError };
        resolve(response.ok ? { result: { ok: true } } : { error: { data: response.error } });
      });
      connection.write(
        `${JSON.stringify({ token: 'daemon-token', positionals: [], ...request })}\n`,
      );
    });
  return {
    leaseId: lease.leaseId,
    sessionName,
    sessionStore,
    leaseRegistry,
    rpc,
    socket,
    send: async (
      command: string,
      positionals: string[],
      meta: Record<string, unknown>,
      flags: Record<string, unknown> = {},
    ) =>
      await rpc('agent_device.command', {
        session: SESSION,
        command,
        positionals,
        flags,
        meta: { tenantId: TENANT, sessionIsolation: 'tenant', sessionExplicit: true, ...meta },
      }),
    close: async () => {
      await closeLoopbackServer(socketServer);
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

// #4935: a label that an adapter overwrites or collapses is still a claim on the lease.

test.each([
  ['a tenant flag beside the owner tenant in meta', { tenant: 'tenant-other' }, 'tenantId'],
  [
    'a provider flag beside the owner provider flag',
    { leaseProvider: 'proxy', provider: 'other' },
    'leaseProvider',
  ],
])('the owner lease id does not admit %s', async (_label, flags, field) => {
  if (!world) return;
  const owner = { ...OWNER_SCOPE, leaseId: world.leaseId };

  expectLeaseFieldRefusal(await world.send('snapshot', [], owner, flags), field);

  const snapshot = await world.send('snapshot', [], owner, { tenant: TENANT, provider: 'proxy' });
  expect(snapshot.result?.ok, JSON.stringify(snapshot)).toBe(true);
});

test.each([
  ['tenant', { tenant: 'tenant-other' }, 'tenantId'],
  ['null tenant', { tenant: null }, 'tenantId'],
  ['numeric tenant id beside a tenant', { tenantId: 5, tenant: TENANT }, 'tenantId'],
  ['provider', { provider: 'other' }, 'leaseProvider'],
  ['backend', { leaseBackend: 'ios-instance', backend: 'android-instance' }, 'leaseBackend'],
])(
  'install_from_source refuses a %s alias that contradicts its sibling param',
  async (_alias, contradiction, field) => {
    if (!world) return;
    const install = {
      session: world.sessionName,
      platform: 'ios',
      source: { kind: 'url', url: 'http://127.0.0.1:9/app.zip' },
      ...OWNER_SCOPE,
      leaseId: world.leaseId,
    };

    expectLeaseFieldRefusal(
      await world.rpc('agent_device.install_from_source', { ...install, ...contradiction }),
      field,
    );

    const owner = await world.rpc('agent_device.install_from_source', {
      ...install,
      tenant: TENANT,
      provider: OWNER_SCOPE.leaseProvider,
      leaseBackend: 'ios-instance',
      backend: 'ios-instance',
    });
    // Admitted: it reaches the device runtime, which this fake device does not implement.
    expect(owner.error?.data?.code, JSON.stringify(owner)).toBe('UNSUPPORTED_OPERATION');
  },
);

function writeAttestingAuthHook(): NodeJS.ProcessEnv {
  const hookPath = path.join(mkdtempForTestSync('agent-device-attesting-hook-'), 'hook.mjs');
  fs.writeFileSync(hookPath, `export default () => ({ tenantId: '${TENANT}' });\n`);
  return { AGENT_DEVICE_HTTP_AUTH_HOOK: hookPath };
}

test('a tenant the caller declares is compared with the lease after the auth hook attests another', async () => {
  if (!world) return;
  await world.close();
  world = await startProxiedDaemon({ env: writeAttestingAuthHook() });
  const owner = { ...OWNER_SCOPE, leaseId: world.leaseId };

  expectLeaseFieldRefusal(
    await world.send('snapshot', [], { ...owner, tenantId: 'tenant-other' }),
    'tenantId',
  );
  expectLeaseFieldRefusal(
    await world.send('snapshot', [], owner, { tenant: 'tenant-other' }),
    'tenantId',
  );

  const snapshot = await world.send('snapshot', [], owner);
  expect(snapshot.result?.ok, JSON.stringify(snapshot)).toBe(true);
});

test('a batch that opens a leased session carries the declared tenant to its later steps', async () => {
  if (!world) return;
  await world.close();
  world = await startProxiedDaemon({ env: writeAttestingAuthHook(), openSession: false });
  const owner = { ...OWNER_SCOPE, leaseBackend: 'ios-instance', leaseId: world.leaseId };
  const batchSteps = [
    { command: 'open', positionals: ['com.example.app'] },
    { command: 'snapshot', positionals: [] },
  ];

  const declared = await world.send(
    'batch',
    [],
    { ...owner, tenantId: 'tenant-other' },
    { platform: 'ios', batchSteps },
  );
  expectLeaseFieldRefusal(declared, 'tenantId');
  expect(declared.error?.data?.details).toMatchObject({ step: 2, executed: 1 });

  const snapshot = await world.send('batch', [], owner, { batchSteps: batchSteps.slice(1) });
  expect(snapshot.result?.ok, JSON.stringify(snapshot)).toBe(true);
});

test('a batch step that names the lease scope itself still carries a run id the batch declared', async () => {
  if (!world) return;
  await world.close();
  world = await startProxiedDaemon({ openSession: false });
  const { rpc, leaseId } = world;
  const { tenantId, ...labels } = OWNER_SCOPE;
  const flags = { ...labels, tenant: tenantId, leaseBackend: 'ios-instance', leaseId };
  const batch = async (batchFlags: Record<string, unknown>) =>
    await rpc('agent_device.command', {
      session: 'fresh',
      command: 'batch',
      positionals: [],
      meta: { sessionExplicit: true },
      flags: {
        platform: 'ios',
        ...batchFlags,
        batchSteps: [
          { command: 'open', positionals: ['com.example.app'], flags },
          { command: 'snapshot', positionals: [], flags },
        ],
      },
    });

  const declared = await batch({ runId: 'run-other' });
  expectLeaseFieldRefusal(declared, 'runId');
  expect(declared.error?.data?.details).toMatchObject({ step: 2, executed: 1 });
});

test.each([5, null])(
  'a run id of %s is refused in meta, in flags and as a param',
  async (runId) => {
    if (!world) return;
    const owner = { ...OWNER_SCOPE, leaseId: world.leaseId };

    expectLeaseFieldRefusal(await world.send('snapshot', [], { ...owner, runId }), 'runId');
    expectLeaseFieldRefusal(await world.send('snapshot', [], owner, { runId }), 'runId');
    expectLeaseFieldRefusal(
      await world.rpc('agent_device.install_from_source', {
        session: world.sessionName,
        platform: 'ios',
        source: { kind: 'url', url: 'http://127.0.0.1:9/app.zip' },
        ...owner,
        runId,
      }),
      'runId',
    );
  },
);

test('the owner is admitted and listed under another spelling of its lease id and labels', async () => {
  if (!world) return;
  const owner = {
    ...OWNER_SCOPE,
    leaseId: ` ${world.leaseId.toUpperCase()} `,
    runId: ` ${OWNER_SCOPE.runId} `,
    clientId: ` ${OWNER_SCOPE.clientId} `,
  };

  const listed = await world.send('session_list', [], owner);
  expect(listed.result?.data?.sessions, JSON.stringify(listed)).toEqual([
    expect.objectContaining({ address: world.sessionName }),
  ]);

  const snapshot = await world.send('snapshot', [], owner);
  expect(snapshot.result?.ok, JSON.stringify(snapshot)).toBe(true);
});

// A tenant that routing replaces, or that routing cannot read, is still a claim on the lease.

test('unattested HTTP routes by the tenant flag and compares the numeric meta tenant', async () => {
  if (!world) return;
  const owner = { ...OWNER_SCOPE, leaseId: world.leaseId };
  const flags = { tenant: TENANT };

  expectLeaseFieldRefusal(
    await world.send('snapshot', [], { ...owner, tenantId: 5 }, flags),
    'tenantId',
  );
  const snapshot = await world.send('snapshot', [], { ...owner, tenantId: undefined }, flags);
  expect(snapshot.result?.ok, JSON.stringify(snapshot)).toBe(true);
});

test('malformed tenant polling leaves an unleased session and its claim eligible for idle expiry', async () => {
  if (!world) return;
  const { sessionStore, leaseRegistry } = world;
  const stateDir = sessionStore.resolveDaemonStateDir();
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', path.join(stateDir, 'claims'));
  const env = { ...process.env, AGENT_DEVICE_SESSION_IDLE_TIMEOUT_MS: '1000' };
  const idleExpiryMs = resolveSessionIdleExpiryMs(env);
  vi.useFakeTimers({ toFake: ['Date'] });
  const openedAt = Date.now();
  const controller = createSessionIdleExpiry({
    env,
    sessionStore,
    idleExpiryMs,
    executionLocks: getLeaseRegistryExecutionLocks(leaseRegistry),
    settleSession: async () => {},
  });
  try {
    const claim = await acquireDeviceClaim({
      env,
      device: IOS_SIMULATOR,
      session: SESSION,
      workspace: stateDir,
      stateDir,
      reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
    });
    if (claim.status !== 'acquired') throw new Error(`Expected a test claim, got ${claim.status}`);
    const claimPath = deviceClaimFilePath(claim.ownership.deviceKey);
    const session = makeIosAppSession(SESSION, {
      createdAt: openedAt,
      deviceClaim: claim.ownership,
    });
    sessionStore.publish(SESSION, session);
    expect(fs.existsSync(claimPath)).toBe(true);
    controller.noteSessionsChanged();
    for (const fraction of [0.25, 0.5, 0.75]) {
      vi.setSystemTime(openedAt + idleExpiryMs * fraction);
      const refused = await world.send('snapshot', [], {
        tenantId: 'not a tenant',
        sessionIsolation: undefined,
      });
      expect(refused.error?.data?.code).toBe('INVALID_ARGS');
      controller.noteSessionsChanged();
    }
    expect(session.lastActivityAtMs).toBeUndefined();
    vi.setSystemTime(openedAt + idleExpiryMs);
    controller.noteSessionsChanged();
    await vi.waitFor(() => expect(sessionStore.get(SESSION)).toBeUndefined());
    expect(fs.existsSync(claimPath)).toBe(false);
  } finally {
    controller.cancel();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

test.each(['session_list', 'devices'])(
  '%s refuses a malformed tenant over HTTP',
  async (command) => {
    if (!world) return;
    const response = await world.send(command, [], {
      tenantId: 'not a tenant',
      sessionIsolation: undefined,
    });
    expect(response.error?.data?.code).toBe('INVALID_ARGS');
  },
);

test('a null meta tenant that tenant routing replaces is refused on the socket, direct and in a batch', async () => {
  if (!world) return;
  const owner = { ...OWNER_SCOPE, leaseBackend: 'ios-instance', leaseId: world.leaseId };
  const snapshot = (meta: Record<string, unknown>) => ({
    session: SESSION,
    command: 'snapshot',
    meta: { ...owner, sessionIsolation: 'tenant', sessionExplicit: true, ...meta },
    flags: { tenant: TENANT },
  });

  expectLeaseFieldRefusal(await world.socket(snapshot({ tenantId: null })), 'tenantId');
  const direct = await world.socket(snapshot({}));
  expect(direct.result?.ok, JSON.stringify(direct)).toBe(true);

  await world.close();
  world = await startProxiedDaemon({ openSession: false });
  const batch = await world.socket({
    ...snapshot({ tenantId: null, leaseId: world.leaseId }),
    command: 'batch',
    flags: {
      tenant: TENANT,
      platform: 'ios',
      batchSteps: [
        { command: 'open', positionals: ['com.example.app'] },
        { command: 'snapshot', positionals: [] },
      ],
    },
  });
  expectLeaseFieldRefusal(batch, 'tenantId');
  expect(batch.error?.data?.details).toMatchObject({ step: 2, executed: 1 });
});

test.each([
  ['a numeric meta tenant', { tenantId: 5 }, {}],
  ['a numeric tenant flag', {}, { tenant: 5 }],
  ['a malformed meta tenant', { tenantId: 'not a tenant' }, {}],
])(
  '%s on a session named without tenant isolation is a lease mismatch',
  async (_label, meta, flags) => {
    if (!world) return;
    const { tenantId: _tenant, ...labels } = OWNER_SCOPE;
    const request = (session: string, tenant: Record<string, unknown>, tenantFlags: object) => ({
      session,
      command: 'snapshot',
      positionals: [],
      flags: tenantFlags,
      meta: { ...labels, leaseId: world!.leaseId, sessionExplicit: true, ...tenant },
    });

    expectLeaseFieldRefusal(
      await world.rpc('agent_device.command', request(world.sessionName, meta, flags)),
      'tenantId',
    );

    // Off a leased session the malformed tenant keeps its own refusal.
    const unleased = await world.rpc('agent_device.command', {
      session: 'unleased',
      command: 'snapshot',
      positionals: [],
      flags,
      meta: { sessionExplicit: true, ...meta },
    });
    expect(unleased.error?.data?.code, JSON.stringify(unleased)).toBe('INVALID_ARGS');
    const owner = await world.rpc('agent_device.command', request(world.sessionName, {}, {}));
    expect(owner.result?.ok, JSON.stringify(owner)).toBe(true);
  },
);
