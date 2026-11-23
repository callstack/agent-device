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
import { hostDiagnosticsFixture } from '../../__tests__/support/host-diagnostics-fixture.ts';
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
  result?: { ok?: boolean; data?: Record<string, unknown> & { lease?: { leaseId: string } } };
  error?: {
    data?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> };
  };
};

async function postCommand(
  url: string,
  token: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'agent_device.command',
      params,
    }),
  });
}

async function sendCommand(
  url: string,
  token: string,
  params: Record<string, unknown>,
): Promise<RpcBody> {
  return (await (await postCommand(url, token, params)).json()) as RpcBody;
}

async function sendStreamingCommand(url: string, token: string, params: Record<string, unknown>) {
  const response = await postCommand(url, token, params);
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  const envelopes = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const terminal = envelopes.pop();
  expect(terminal?.type).toBe('response');
  return {
    body: terminal.response as RpcBody,
    progress: envelopes.map((envelope) => envelope.event?.message as string),
  };
}

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
        backend: holderLease.backend,
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
    hostDiagnostics: hostDiagnosticsFixture(),
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => [DEVICE],
    }),
    deviceRuntimeGateway: {
      ...lifecycleDeviceRuntimeGateway,
      inspectFacts: async (device) => {
        const facts = await lifecycleDeviceRuntimeGateway.inspectFacts(device);
        return {
          ...facts,
          operations: { ...facts.operations, shutdownTarget: { available: true } },
        };
      },
    },
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
  const localUrl = `http://127.0.0.1:${daemonPort}/rpc`;
  const proxyUrl = `http://127.0.0.1:${proxyPort}/agent-device/rpc`;
  return {
    streamLocal: (params: Record<string, unknown>) =>
      sendStreamingCommand(localUrl, 'daemon-token', params),
    streamProxy: (params: Record<string, unknown>) =>
      sendStreamingCommand(proxyUrl, PROXY_TOKEN, params),
    holderLeaseId: holderLease.leaseId,
    peerLeaseId: peerLease.leaseId,
    holderSessionName,
    sessionStore,
    sendLocal: (params: Record<string, unknown>) => sendCommand(localUrl, 'daemon-token', params),
    /** Sends `command` as `session` with the given lease metadata and flags. */
    send: (
      session: string,
      command: string,
      params: { meta?: Record<string, unknown>; flags?: Record<string, unknown> } = {},
      positionals: string[] = [],
    ) =>
      sendCommand(proxyUrl, PROXY_TOKEN, {
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
      }),
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

test('a proxy client is refused a device held by a local session without learning its name', async () => {
  if (!world) return;
  const localHolder = 'local-holder-session';
  world.sessionStore.retire(world.sessionStore.lookup(world.holderSessionName)!);
  world.sessionStore.publish(
    localHolder,
    makeIosAppSession(localHolder, {
      sessionScope: { kind: 'named-local' },
      device: DEVICE,
    }),
  );

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
  expect(JSON.stringify(refusal)).not.toContain(localHolder);
});

test('a shared-token proxy client without tenant isolation does not learn a local holder name', async () => {
  if (!world) return;
  const localHolder = 'local-holder-unisolated';
  world.sessionStore.retire(world.sessionStore.lookup(world.holderSessionName)!);
  world.sessionStore.publish(
    localHolder,
    makeIosAppSession(localHolder, {
      sessionScope: { kind: 'named-local' },
      device: DEVICE,
    }),
  );

  // The client keeps its lease metadata but sends no tenant isolation, so only the proxy's
  // public-network admission marks it as remote.
  const refusal = await world.send(
    PEER,
    'open',
    {
      meta: { ...PEER_SCOPE, leaseId: world.peerLeaseId, sessionIsolation: undefined },
      flags: { waitMs: 400 },
    },
    ['com.example.app'],
  );

  expect(refusal.error?.data?.code, JSON.stringify(refusal)).toBe('DEVICE_IN_USE');
  expect(JSON.stringify(refusal)).not.toContain(localHolder);
});

test('implicit shutdown names a cwd-scoped holder only in its own workspace', async () => {
  if (!world) return;
  world.sessionStore.retire(world.sessionStore.lookup(world.holderSessionName)!);
  const holderCwd = mkdtempForTestSync('agent-device-shutdown-holder-');
  const otherCwd = mkdtempForTestSync('agent-device-shutdown-other-');
  const flags = { platform: 'ios', udid: DEVICE.id };
  const opened = await world.sendLocal({
    command: 'open',
    positionals: ['com.example.app'],
    flags,
    meta: { cwd: holderCwd },
  });
  expect(opened.result?.ok, JSON.stringify(opened)).toBe(true);
  const holder = world.sessionStore.findByDevice(DEVICE.id)!;
  expect(holder.session.sessionScope?.kind).toBe('cwd');
  expect(holder.session.lease).toBeUndefined();

  const refused = await world.sendLocal({
    command: 'shutdown',
    flags,
    meta: { cwd: otherCwd },
  });
  expect(refused.error?.data?.code, JSON.stringify(refused)).toBe('DEVICE_IN_USE');
  expect(JSON.stringify(refused)).not.toContain(holder.address);

  const ownRefusal = await world.sendLocal({
    command: 'shutdown',
    flags,
    meta: { cwd: holderCwd },
  });
  expect(ownRefusal.error?.data).toMatchObject({
    code: 'DEVICE_IN_USE',
    hint: `Run agent-device close --shutdown --session ${holder.address}`,
    details: { session: holder.address },
  });
});

test('an implicit open in another workspace does not name a leased cwd-scoped holder', async () => {
  if (!world) return;
  world.sessionStore.retire(world.sessionStore.lookup(world.holderSessionName)!);
  const holderCwd = mkdtempForTestSync('agent-device-leased-open-holder-');
  const otherCwd = mkdtempForTestSync('agent-device-leased-open-other-');
  const scope = { tenantId: 'local', runId: 'workspace-holder' };
  const allocated = await world.sendLocal({ command: 'lease_allocate', meta: scope });
  const leaseId = allocated.result?.data?.lease?.leaseId;
  expect(leaseId, JSON.stringify(allocated)).toBeTypeOf('string');

  const open = {
    command: 'open',
    positionals: ['com.example.app'],
    flags: { platform: 'ios', udid: DEVICE.id },
  };
  const opened = await world.sendLocal({
    ...open,
    meta: { ...scope, cwd: holderCwd, leaseId },
  });
  expect(opened.result?.ok, JSON.stringify(opened)).toBe(true);
  const holder = world.sessionStore.findByDevice(DEVICE.id)!;
  expect(holder.session.sessionScope?.kind).toBe('cwd');
  expect(holder.session.lease).toMatchObject({ leaseId });
  expect(holder.session.lease?.leaseProvider).toBeUndefined();

  const refused = await world.sendLocal({ ...open, meta: { cwd: otherCwd } });
  expect(refused.error?.data?.code, JSON.stringify(refused)).toBe('DEVICE_IN_USE');
  expect(JSON.stringify(refused)).not.toContain(holder.address);
  expect(refused.error?.data?.details?.session).toBeUndefined();
});

test('listing, doctor, and open disclose names according to caller scope and recovery intent', async () => {
  if (!world) return;
  const tenantHolder = world.sessionStore.lookup(world.holderSessionName)!;
  const localName = 'unleased-local-holder';
  const leasedName = 'leased-shared-token-holder';
  const otherLeaseName = 'other-lease-holder';
  const app = 'com.example.privateholder';
  const flags = { platform: 'ios', udid: DEVICE.id };
  const sharedOwner = {
    ...HOLDER_SCOPE,
    leaseId: world.holderLeaseId,
    sessionIsolation: undefined,
  };
  const tenantPeer = { ...PEER_SCOPE, leaseId: world.peerLeaseId };
  const addresses = (body: RpcBody) => {
    expect(body.result?.ok).toBe(true);
    const sessions = body.result?.data?.sessions as { address: string }[];
    return sessions.map(({ address }) => address);
  };
  const wait = {
    command: 'open',
    flags: { ...flags, waitMs: 400 },
    positionals: ['com.example.app'],
  };

  const tenantList = await world.send(PEER, 'session_list', { meta: tenantPeer });
  const tenantOwnerList = await world.send(HOLDER, 'session_list', {
    meta: { ...HOLDER_SCOPE, leaseId: world.holderLeaseId },
  });
  const tenantWait = await world.streamProxy({
    ...wait,
    session: PEER,
    meta: { ...tenantPeer, sessionIsolation: 'tenant', requestProgress: 'command' },
  });
  world.sessionStore.retire(tenantHolder);
  const leasedHolder = world.sessionStore.publish(
    leasedName,
    makeIosAppSession(leasedName, {
      sessionScope: { kind: 'named-local' },
      device: DEVICE,
      lease: tenantHolder.session.lease,
    }),
  );
  const otherLease = world.sessionStore.publish(
    otherLeaseName,
    makeIosAppSession(otherLeaseName, {
      sessionScope: { kind: 'named-local' },
      device: { ...DEVICE, id: 'sim-other' },
      lease: { ...tenantHolder.session.lease!, leaseId: world.peerLeaseId },
    }),
  );
  const localHolder = world.sessionStore.publish(
    localName,
    makeIosAppSession(localName, {
      sessionScope: { kind: 'named-local' },
      appBundleId: app,
      device: { ...DEVICE, id: 'sim-local' },
    }),
  );

  const sharedList = await world.send(PEER, 'session_list', { meta: sharedOwner });
  const matchingWait = await world.streamProxy({
    ...wait,
    session: PEER,
    meta: { ...sharedOwner, requestProgress: 'command' },
  });
  const doctor = await world.streamProxy({
    command: 'doctor',
    session: localName,
    flags: { remote: true },
    meta: { ...sharedOwner, requestProgress: 'command' },
  });
  world.sessionStore.retire(leasedHolder);
  world.sessionStore.retire(otherLease);
  world.sessionStore.retire(localHolder);
  world.sessionStore.publish(
    localName,
    makeIosAppSession(localName, {
      sessionScope: { kind: 'named-local' },
      device: DEVICE,
    }),
  );
  const hiddenWait = await world.streamProxy({
    ...wait,
    session: PEER,
    meta: { ...sharedOwner, requestProgress: 'command' },
  });
  world.sessionStore.retire(world.sessionStore.lookup(localName)!);

  const holderCwd = mkdtempForTestSync('agent-device-visibility-holder-');
  const callerCwd = mkdtempForTestSync('agent-device-visibility-caller-');
  const opened = await world.sendLocal({ ...wait, flags, meta: { cwd: holderCwd } });
  expect(opened.result?.ok).toBe(true);
  const workspaceHolder = world.sessionStore.findByDevice(DEVICE.id)!;
  const localList = await world.sendLocal({ command: 'session_list', meta: { cwd: callerCwd } });
  const localWait = await world.streamLocal({
    ...wait,
    meta: { cwd: callerCwd, requestProgress: 'command' },
  });

  expect(addresses(tenantList)).toEqual([]);
  expect(addresses(tenantOwnerList)).toEqual([tenantHolder.address]);
  expect(addresses(sharedList)).toEqual([leasedName]);
  expect(addresses(localList)).toEqual([]);
  expect(doctor.body.result?.ok).toBe(true);
  expect(doctor.body.result?.data?.targetApp).toBeUndefined();
  expect(doctor.progress.join('\n')).toContain('No active session');
  expect(doctor.progress.join('\n')).not.toContain(localName);

  for (const [result, holder, visible] of [
    [tenantWait, tenantHolder.address, false],
    [matchingWait, leasedName, true],
    [hiddenWait, localName, false],
    [localWait, workspaceHolder.address, true],
  ] as const) {
    expect(result.body.error?.data?.code, JSON.stringify(result.body)).toBe('DEVICE_IN_USE');
    const progress = result.progress.filter((message) => message?.startsWith('Waiting for'));
    expect(progress.length).toBeGreaterThan(0);
    if (visible) {
      expect(progress.join('\n')).toContain(holder);
      expect(result.body.error?.data?.details?.session).toBe(holder);
    } else {
      expect(progress.join('\n')).toContain('held by another session');
      expect(progress.join('\n')).not.toContain(holder);
      expect(JSON.stringify(result.body)).not.toContain(holder);
    }
  }
});
