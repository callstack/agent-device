// Two clients share one proxy token, so both are one tenant to the daemon and differ only by the
// lease id they carry. Neither a `devices` list, a busy-device `open`, nor a claim-conflict refusal
// may carry the holder's session address to a caller that may not see it (#4923). The caller that
// carries the holder's lease id — the one the lease was allocated to — keeps learning the name.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createDaemonProxyServer } from '@agent-device/proxy';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  IOS_SIMULATOR,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { acquireDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import { createDaemonHttpServer } from './http-server.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { retainOrphanedDeviceClaims } from '../../__tests__/support/device-claim-store.ts';
import { makeIosAppSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { tenantScopedSessionName } from '../../core/session-tenant-scope.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';

const PROXY_TOKEN = 'shared-proxy-token';
const TENANT = 'e2b';
const HOLDER = 'agentA';
const PEER = 'agentB';
const DEVICE = IOS_SIMULATOR;
/** The holder's own lease scope, as its client sends it; `proxy` names a route, not an instance. */
const HOLDER_SCOPE = {
  tenantId: TENANT,
  runId: 'run-a',
  leaseProvider: 'proxy',
  clientId: 'client-a',
  deviceKey: 'ios:mobile:sim-1',
} as const;
/** The peer's own lease scope: same tenant, its own run, and no lease bound to this device. */
const PEER_SCOPE = {
  tenantId: TENANT,
  runId: 'run-b',
  leaseProvider: 'proxy',
  clientId: 'client-b',
  deviceKey: 'ios:mobile:sim-2',
} as const;

type RpcBody = {
  result?: { ok?: boolean; data?: Record<string, unknown> };
  error?: {
    data?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> };
  };
};

let world: Awaited<ReturnType<typeof startProxiedDaemon>> | undefined;
let previousClaimsDir: string | undefined;
let claimsDir: string;

beforeEach(async (context) => {
  if (await skipWhenLoopbackUnavailable(context)) return;
  claimsDir = mkdtempForTestSync('agent-device-proxy-reply-visibility-claims-');
  previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  world = await startProxiedDaemon();
});

afterEach(async () => {
  await world?.close();
  world = undefined;
  if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
  fs.rmSync(claimsDir, { recursive: true, force: true });
});

async function startProxiedDaemon() {
  const sessionStore = makeSessionStore('agent-device-proxy-reply-visibility-');
  const leaseRegistry = new LeaseRegistry();
  // No backend is named anywhere: admission defaults both the allocation and the request to the
  // same backend, so each client admits exactly its own lease.
  const holderLease = leaseRegistry.allocateLease(HOLDER_SCOPE);
  const peerLease = leaseRegistry.allocateLease(PEER_SCOPE);
  const holderSessionName = tenantScopedSessionName(TENANT, HOLDER);
  sessionStore.publish(
    holderSessionName,
    makeIosAppSession(holderSessionName, {
      sessionScope: { kind: 'tenant', id: TENANT },
      device: DEVICE,
      lease: {
        leaseId: holderLease.leaseId,
        tenantId: TENANT,
        runId: HOLDER_SCOPE.runId,
        leaseBackend: holderLease.backend,
        leaseProvider: HOLDER_SCOPE.leaseProvider,
        clientId: HOLDER_SCOPE.clientId,
        deviceKey: HOLDER_SCOPE.deviceKey,
      },
    }),
  );
  const handleRequest = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(
      mkdtempForTestSync('agent-device-proxy-reply-visibility-log-'),
      'daemon.log',
    ),
    token: 'daemon-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => [DEVICE],
    }),
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
  return {
    holderLeaseId: holderLease.leaseId,
    peerLeaseId: peerLease.leaseId,
    holderSessionName,
    sessionStore,
    /** Sends `command` as `session` with the given lease metadata and flags. */
    send: async (
      session: string,
      command: string,
      params: { meta?: Record<string, unknown>; flags?: Record<string, unknown> } = {},
      positionals: string[] = [],
    ) => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/agent-device/rpc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${PROXY_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'agent_device.command',
          params: {
            session,
            command,
            positionals,
            flags: params.flags ?? {},
            meta: {
              tenantId: TENANT,
              sessionIsolation: 'tenant',
              sessionExplicit: true,
              ...params.meta,
            },
          },
        }),
      });
      return (await response.json()) as RpcBody;
    },
    /** Writes the live claim this daemon would have left for its holder session on this device. */
    seedHolderClaim: async () => {
      const acquired = await acquireDeviceClaim({
        device: DEVICE,
        session: tenantScopedSessionName(TENANT, HOLDER),
        workspace: '/work/holder',
        stateDir: sessionStore.resolveDaemonStateDir(),
        env: process.env,
        reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
      });
      if (acquired.status !== 'acquired') throw new Error('fixture claim was not acquired');
    },
    close: async () => {
      await closeLoopbackServer(proxy);
      await closeLoopbackServer(daemon);
    },
  };
}

function expectNoHolderName(body: RpcBody): void {
  const serialized = JSON.stringify(body);
  expect(serialized, serialized).not.toContain(HOLDER);
}

test('the lease holder sees its own session in the claimed-device list', async () => {
  if (!world) return;
  await world.seedHolderClaim();

  const asHolder = await world.send(HOLDER, 'devices', {
    meta: { ...HOLDER_SCOPE, leaseId: world.holderLeaseId },
  });

  expect(asHolder.result?.ok, JSON.stringify(asHolder)).toBe(true);
  expect(JSON.stringify(asHolder)).toContain(HOLDER);
});

test('the peer client lists a claimed device without the holder session', async () => {
  if (!world) return;
  await world.seedHolderClaim();

  const asPeer = await world.send(PEER, 'devices', {
    meta: { ...PEER_SCOPE, leaseId: world.peerLeaseId },
  });

  expect(asPeer.result?.ok, JSON.stringify(asPeer)).toBe(true);
  expectNoHolderName(asPeer);
});

test('the peer client is refused a busy device without learning the holder session', async () => {
  if (!world) return;

  const refusal = await world.send(
    PEER,
    'open',
    {
      meta: { ...PEER_SCOPE, leaseId: world.peerLeaseId },
      flags: { waitMs: 400 },
    },
    ['com.example.app'],
  );

  expect(refusal.error?.data?.code, JSON.stringify(refusal)).toBe('DEVICE_IN_USE');
  expectNoHolderName(refusal);
});

test('the caller that carries the holder lease id still learns the holder session', async () => {
  if (!world) return;

  // The lease's own scope labels with its id: the client the lease was allocated to.
  const refusal = await world.send(
    PEER,
    'open',
    {
      meta: { ...HOLDER_SCOPE, leaseId: world.holderLeaseId },
      flags: { waitMs: 400 },
    },
    ['com.example.app'],
  );

  expect(refusal.error?.data?.code, JSON.stringify(refusal)).toBe('DEVICE_IN_USE');
  expect(JSON.stringify(refusal)).toContain(HOLDER);
});

test('the peer client gets a claim conflict without the holder session', async () => {
  if (!world) return;
  // Close the holder's session-table entry so the refusal comes from the claim alone: the claim
  // outliving its session is the case whose unverified owner label must not be confirmed.
  await world.send(HOLDER, 'close', { meta: { ...HOLDER_SCOPE, leaseId: world.holderLeaseId } });
  await world.seedHolderClaim();

  const refusal = await world.send(
    PEER,
    'open',
    { meta: { ...PEER_SCOPE, leaseId: world.peerLeaseId } },
    ['com.example.app'],
  );

  expect(refusal.error?.data?.code, JSON.stringify(refusal)).toBe('DEVICE_IN_USE');
  expect(String(refusal.error?.data?.details?.reason)).toMatch(/DEVICE_CLAIM/);
  expectNoHolderName(refusal);
});
