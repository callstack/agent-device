import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { HOST_LEASE_HTTP_PREFIX } from '../host-lease-http.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createDaemonHttpServer } from '../server/http-server.ts';

const LEASE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const BODY = {
  tenantId: 'stim',
  runId: 'session-1',
  clientId: 'client-1',
  leaseBackend: 'macos-app',
  leaseProvider: 'proxy',
  deviceKey: 'com.example.app@4242',
  ttlMs: 60_000,
};

async function withServer(
  t: Parameters<typeof skipWhenLoopbackUnavailable>[0],
  run: (origin: string, registry: LeaseRegistry) => Promise<void>,
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const registry = new LeaseRegistry();
  const server = await createDaemonHttpServer({
    token: 'daemon-token',
    leaseRegistry: registry,
    handleRequest: async () => ({ ok: true, data: {} }),
  });
  try {
    const port = await listenOnLoopback(server);
    await run(`http://127.0.0.1:${String(port)}`, registry);
  } finally {
    await closeLoopbackServer(server);
  }
}

function put(origin: string, leaseId: string, body: unknown, token = 'daemon-token') {
  return fetch(`${origin}${HOST_LEASE_HTTP_PREFIX}/${leaseId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('the host allocates a macos-app lease under the id it chose and renews it', async (t) => {
  await withServer(t, async (origin, registry) => {
    const created = await put(origin, LEASE_ID, BODY);
    assert.equal(created.status, 200);
    const { lease } = (await created.json()) as { lease: Record<string, unknown> };
    assert.equal(lease.leaseId, LEASE_ID);
    assert.equal(lease.backend, 'macos-app');
    assert.equal(lease.deviceKey, 'com.example.app@4242');
    assert.equal(lease.retainOnClose, true);
    registry.assertLeaseAdmission({
      leaseId: LEASE_ID,
      tenantId: 'stim',
      runId: 'session-1',
      leaseBackend: 'macos-app',
    });

    const renewed = await put(origin, LEASE_ID, BODY);
    assert.equal(renewed.status, 200);
    assert.equal(registry.listActiveLeases().length, 1);

    const listed = await fetch(`${origin}${HOST_LEASE_HTTP_PREFIX}`, {
      headers: { authorization: 'Bearer daemon-token' },
    });
    assert.deepEqual(
      ((await listed.json()) as { leases: { leaseId: string }[] }).leases.map((l) => l.leaseId),
      [LEASE_ID],
    );
  });
});

test('an existing lease id is never rewritten to another scope', async (t) => {
  await withServer(t, async (origin, registry) => {
    assert.equal((await put(origin, LEASE_ID, BODY)).status, 200);
    const widened = await put(origin, LEASE_ID, { ...BODY, deviceKey: 'com.apple.finder' });
    assert.equal(widened.status, 400);
    assert.equal(registry.listActiveLeases()[0]?.deviceKey, 'com.example.app@4242');
  });
});

test('the route takes only the daemon token and only macos-app leases', async (t) => {
  await withServer(t, async (origin, registry) => {
    assert.equal((await put(origin, LEASE_ID, BODY, 'tenant-credential')).status, 401);
    assert.equal(
      (await put(origin, LEASE_ID, { ...BODY, leaseBackend: 'ios-instance' })).status,
      400,
    );
    assert.equal((await put(origin, LEASE_ID, { ...BODY, deviceKey: 'not a bundle' })).status, 400);
    assert.equal((await put(origin, LEASE_ID, { ...BODY, surface: 'desktop' })).status, 400);
    assert.deepEqual(registry.listActiveLeases(), []);
  });
});

test('DELETE revokes the lease so the next admission fails', async (t) => {
  await withServer(t, async (origin, registry) => {
    assert.equal((await put(origin, LEASE_ID, BODY)).status, 200);
    const removed = await fetch(`${origin}${HOST_LEASE_HTTP_PREFIX}/${LEASE_ID}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer daemon-token' },
    });
    assert.equal(((await removed.json()) as { released: boolean }).released, true);
    assert.throws(
      () =>
        registry.assertLeaseAdmission({ leaseId: LEASE_ID, tenantId: 'stim', runId: 'session-1' }),
      { code: 'UNAUTHORIZED' },
    );
  });
});

test('/health names macos-app among the lease backends only on a macOS host', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    for (const [hostPlatform, advertised] of [
      ['darwin', true],
      ['linux', false],
    ] as const) {
      Object.defineProperty(process, 'platform', { ...platform, value: hostPlatform });
      await withServer(t, async (origin) => {
        const health = (await (await fetch(`${origin}/health`)).json()) as {
          leaseBackends?: string[];
        };
        assert.ok(health.leaseBackends?.includes('ios-simulator'));
        assert.equal(health.leaseBackends?.includes('macos-app'), advertised);
      });
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});
