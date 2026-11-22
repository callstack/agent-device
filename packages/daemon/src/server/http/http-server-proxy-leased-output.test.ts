import fs from 'node:fs';
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
import {
  DAEMON_HTTP_LEASE_HEADER,
  DAEMON_HTTP_TENANT_HEADER,
} from '@agent-device/contracts/daemon-http';
import { resolveSessionRequestLogPath } from '@agent-device/daemon-contracts/session-artifact-paths';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type { DiagnosticsRecordRef } from '@agent-device/kernel/errors';
import { createDaemonHttpServer } from './http-server.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeAndroidSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { screenshotRuntimeFixture } from '../../__tests__/support/screenshot-runtime-fixture.ts';
import { screenshotCommandSurface } from '../../__tests__/support/screenshot-command-surface-fake.ts';
import { tenantScopedSessionName } from '../../core/session-tenant-scope.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  cleanupDownloadableArtifact,
  listDownloadableArtifacts,
  trackDownloadableArtifact,
} from '../../resources/artifact-tracking.ts';

// One proxy token and one tenant label for every client, as a host with many sandboxes has.
const PROXY_TOKEN = 'shared-proxy-token';
const TENANT = 'e2b';
const SESSION = 'agentA';
const OWNER_SCOPE = { tenantId: TENANT, runId: 'run-a' } as const;
const OTHER_LEASE_ID = 'f'.repeat(32);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type RpcBody = {
  result?: { ok?: boolean; data?: Record<string, unknown> };
  error?: {
    data?: {
      code?: string;
      details?: { reason?: string; field?: string };
      diagnosticsRecord?: DiagnosticsRecordRef;
    };
  };
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
  const sessionStore = makeSessionStore('agent-device-proxy-leased-output-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({ ...OWNER_SCOPE, leaseBackend: 'android-instance' });
  const sessionName = tenantScopedSessionName(TENANT, SESSION);
  sessionStore.publish(
    sessionName,
    makeAndroidSession(sessionName, {
      sessionScope: { kind: 'tenant', id: TENANT },
      lease: { leaseId: lease.leaseId, ...OWNER_SCOPE, leaseBackend: lease.backend },
    }),
  );
  const handleRequest = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: screenshotCommandSurface,
    logPath: path.join(mkdtempForTestSync('agent-device-proxy-leased-output-log-'), 'daemon.log'),
    token: 'daemon-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: screenshotRuntimeFixture().gateway,
    trackDownloadableArtifact,
  });
  const daemon = await createDaemonHttpServer({
    token: 'daemon-token',
    handleRequest,
    leaseRegistry,
    resolveRequestDiagnosticsPath: (ref, directory) =>
      resolveSessionRequestLogPath(
        sessionStore.resolveSessionDir(ref.session),
        ref.requestId,
        directory,
      ),
    env: {},
    cwd: process.cwd(),
  });
  const daemonPort = await listenOnLoopback(daemon);
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${daemonPort}`,
    upstreamToken: 'daemon-token',
    clientToken: PROXY_TOKEN,
  });
  const base = `http://127.0.0.1:${await listenOnLoopback(proxy)}/agent-device`;
  const headers = (leaseId: string | undefined) => ({
    authorization: `Bearer ${PROXY_TOKEN}`,
    [DAEMON_HTTP_TENANT_HEADER]: TENANT,
    ...(leaseId ? { [DAEMON_HTTP_LEASE_HEADER]: leaseId } : {}),
  });
  const send = async (
    command: string,
    session: string,
    meta: Record<string, unknown>,
    flags: Record<string, unknown> = {},
  ): Promise<RpcBody> => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PROXY_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: command,
        method: 'agent_device.command',
        params: {
          session,
          command,
          positionals: [],
          flags,
          meta: { tenantId: TENANT, sessionIsolation: 'tenant', sessionExplicit: true, ...meta },
        },
      }),
    });
    return (await response.json()) as RpcBody;
  };
  return {
    owner: { ...OWNER_SCOPE, leaseId: lease.leaseId },
    leaseId: lease.leaseId,
    sessionName,
    sessionStore,
    leaseRegistry,
    send,
    get: async (route: string, leaseId?: string) =>
      await fetch(`${base}${route}`, { headers: headers(leaseId) }),
    close: async () => {
      for (const reader of [{ tenantId: TENANT, leaseId: lease.leaseId }, { tenantId: TENANT }]) {
        for (const { id } of await listDownloadableArtifacts(reader, {})) {
          cleanupDownloadableArtifact(id);
        }
      }
      await closeLoopbackServer(proxy);
      await closeLoopbackServer(daemon);
    },
  };
}

async function listedIds(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { artifacts: Array<{ id: string }> };
  return body.artifacts.map((artifact) => artifact.id);
}

async function rpcListedIds(body: RpcBody): Promise<string[]> {
  expect(body.result?.ok, JSON.stringify(body)).toBe(true);
  return (body.result!.data!.artifacts as Array<{ id: string }>).map((artifact) => artifact.id);
}

async function expectLeasedOutputRefusal(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    ok: false,
    code: 'UNAUTHORIZED',
    reason: 'LEASE_OUTPUT_MISMATCH',
    field: 'leaseId',
  });
}

/** Ends the session and its lease, as a close of the leased session does. */
function endLeasedSession(daemon: NonNullable<typeof world>): void {
  daemon.sessionStore.retire(daemon.sessionStore.lookup(daemon.sessionName)!);
  daemon.leaseRegistry.releaseLease({ ...OWNER_SCOPE, leaseId: daemon.leaseId });
  expect(daemon.leaseRegistry.listActiveLeases()).toEqual([]);
}

async function takeLeasedScreenshot(daemon: NonNullable<typeof world>): Promise<string> {
  const shot = await daemon.send('screenshot', SESSION, daemon.owner);
  expect(shot.result?.ok, JSON.stringify(shot)).toBe(true);
  const [artifact] = shot.result!.data!.artifacts as Array<{ artifactId: string }>;
  return artifact!.artifactId;
}

test('a client with the same token and tenant cannot list or download a leased screenshot', async () => {
  if (!world) return;
  const artifactId = await takeLeasedScreenshot(world);

  expect(await listedIds(await world.get('/artifacts'))).toEqual([]);
  expect(await listedIds(await world.get('/artifacts', OTHER_LEASE_ID))).toEqual([]);
  expect(await rpcListedIds(await world.send('artifacts', 'agentB', {}))).toEqual([]);
  await expectLeasedOutputRefusal(await world.get(`/artifacts/${artifactId}`));
  await expectLeasedOutputRefusal(await world.get(`/artifacts/${artifactId}`, OTHER_LEASE_ID));

  expect(await listedIds(await world.get('/artifacts', world.leaseId))).toEqual([artifactId]);
  expect(await rpcListedIds(await world.send('artifacts', SESSION, world.owner))).toEqual([
    artifactId,
  ]);
});

test('the owner downloads a leased screenshot after its session and lease ended', async () => {
  if (!world) return;
  const artifactId = await takeLeasedScreenshot(world);
  endLeasedSession(world);

  expect(await listedIds(await world.get('/artifacts'))).toEqual([]);
  await expectLeasedOutputRefusal(await world.get(`/artifacts/${artifactId}`));
  expect(await rpcListedIds(await world.send('artifacts', SESSION, {}))).toEqual([]);

  expect(await listedIds(await world.get('/artifacts', world.leaseId.toUpperCase()))).toEqual([
    artifactId,
  ]);
  // The CLI sends the ended lease id on `artifacts` after close.
  expect(await rpcListedIds(await world.send('artifacts', SESSION, world.owner))).toEqual([
    artifactId,
  ]);
  const download = await world.get(`/artifacts/${artifactId}`, world.leaseId);
  expect(download.status).toBe(200);
  const bytes = Buffer.from(await download.arrayBuffer());
  expect(bytes.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
});

test('only the owner reads the diagnostics record of a request on its leased session', async () => {
  if (!world) return;
  const failed = await world.send('press', SESSION, world.owner);
  const record = failed.error?.data?.diagnosticsRecord;
  expect(record, JSON.stringify(failed)).toMatchObject({ session: world.sessionName });
  const route = `/sessions/${encodeURIComponent(record!.session)}/requests/${record!.requestId}/diagnostics`;

  await expectLeasedOutputRefusal(await world.get(route));
  await expectLeasedOutputRefusal(await world.get(route, OTHER_LEASE_ID));
  const owned = await world.get(route, world.leaseId);
  expect(owned.status).toBe(200);
  const served = await owned.text();
  expect(served).toContain('"phase":"request_failed"');
  // The record that a client downloads holds no credential to replay.
  expect(served).not.toContain(world.leaseId);

  endLeasedSession(world);

  await expectLeasedOutputRefusal(await world.get(route));
  expect((await world.get(route, world.leaseId)).status).toBe(200);
});

test('a request that a leased session refused reads its own record, which names no lease id', async () => {
  if (!world) return;
  const refused = await world.send('press', SESSION, { leaseId: OTHER_LEASE_ID });
  expect(refused.error?.data?.details).toMatchObject({ reason: 'LEASE_SESSION_MISMATCH' });
  const record = refused.error?.data?.diagnosticsRecord;
  expect(record, JSON.stringify(refused)).toBeDefined();
  const route = `/sessions/${encodeURIComponent(record!.session)}/requests/${record!.requestId}/diagnostics`;

  // The owner of a record is the lease id that its request sent, not the lease of the session.
  await expectLeasedOutputRefusal(await world.get(route));
  await expectLeasedOutputRefusal(await world.get(route, world.leaseId));
  const own = await world.get(route, OTHER_LEASE_ID);
  expect(own.status).toBe(200);
  const served = await own.text();
  expect(served).not.toContain(world.leaseId);
  expect(served).not.toContain(OTHER_LEASE_ID);
});

test('two requests that reuse one request id get one record each', async () => {
  if (!world) return;
  const requestId = 'reused-request-id';
  const owned = await world.send('press', SESSION, { ...world.owner, requestId });
  const refused = await world.send('press', SESSION, { requestId });
  const records = [owned, refused].map((body) => body.error?.data?.diagnosticsRecord);
  expect(records[0]?.requestId).not.toBe(records[1]?.requestId);
  const route = (record: DiagnosticsRecordRef | undefined) =>
    `/sessions/${encodeURIComponent(record!.session)}/requests/${record!.requestId}/diagnostics`;

  // Each caller still reads its own record: neither request changed the owner of the other.
  expect((await world.get(route(records[0]), world.leaseId)).status).toBe(200);
  await expectLeasedOutputRefusal(await world.get(route(records[0])));
  expect((await world.get(route(records[1]))).status).toBe(200);
  // The request id of the caller names no record.
  expect((await world.get(route({ ...records[0]!, requestId }), world.leaseId)).status).toBe(404);
});

test('a request with no lease on a session with no lease keeps the tenant rule', async () => {
  if (!world) return;
  const failed = await world.send('press', 'agentB', {});
  const record = failed.error?.data?.diagnosticsRecord;
  expect(record, JSON.stringify(failed)).toBeDefined();

  const own = await world.get(
    `/sessions/${encodeURIComponent(record!.session)}/requests/${record!.requestId}/diagnostics`,
  );

  expect(own.status).toBe(200);
});

test('a routed batch step writes a record under its own lease', async () => {
  if (!world) return;
  const session = 'nested';
  const batch = await world.send(
    'batch',
    session,
    {
      sessionIsolation: undefined,
      debug: true,
    },
    {
      batchSteps: [
        {
          command: 'open',
          flags: {
            leaseId: world.leaseId,
            runId: OWNER_SCOPE.runId,
            leaseBackend: 'android-instance',
          },
          positionals: ['com.example.app'],
        },
      ],
    },
  );
  expect(batch.error?.data?.diagnosticsRecord, JSON.stringify(batch)).toBeDefined();
  const parentRecord = batch.error!.data!.diagnosticsRecord!;
  const recordDir = path.join(world.sessionStore.resolveSessionDir(session), 'request-records');
  const records = fs.readdirSync(recordDir);
  const child = records.find((file) => file !== `${parentRecord.requestId}.ndjson`);
  expect(child, JSON.stringify(records)).toBeDefined();
  const route = (recordId: string) => `/sessions/${session}/requests/${recordId}/diagnostics`;
  await expectLeasedOutputRefusal(await world.get(route(path.basename(child!, '.ndjson'))));
  const own = await world.get(route(path.basename(child!, '.ndjson')), world.leaseId);
  expect(own.status).toBe(200);
  expect(await own.text()).toContain('"command":"open"');
  const parent = await world.get(route(parentRecord.requestId));
  expect(parent.status).toBe(200);
  expect(await parent.text()).not.toContain('"command":"open"');
});
