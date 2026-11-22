import fs from 'node:fs';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

// The lease id is the credential for a lease (#4909). Labels a caller can guess — the tenant, run,
// backend, provider, device key, and client id — are not one, so repeating them must not hand back
// the lease id of the caller that allocated the lease.

const PROXY_SCOPE = {
  tenantId: 'e2b',
  runId: 'run-a',
  leaseProvider: 'proxy',
  clientId: 'client-a',
  deviceKey: 'ios:mobile:SIM-001',
  backend: 'ios-instance',
} as const;

const PLAIN_SCOPE = {
  tenantId: 'e2b',
  runId: 'run-b',
  backend: 'android-instance',
} as const;

type RpcBody = {
  result?: { ok?: boolean; data?: { lease?: Record<string, unknown>; reused?: boolean } };
  error?: { data?: { code?: string; details?: Record<string, unknown> } };
};

let daemon: { close: () => Promise<void>; httpPort: number; token: string };

beforeEach(async () => {
  const stateDir = mkdtempForTestSync('agent-device-run-binding-');
  const runtime = await startDaemonRuntime({
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
    }),
    stderr: { write: () => {} },
    stdout: { write: () => {} },
    composeDeps: daemonRuntimeDepsFixture({}),
  });
  const { httpPort, token } = JSON.parse(
    fs.readFileSync(resolveDaemonPaths(stateDir).infoPath, 'utf8'),
  ) as { httpPort: number; token: string };
  daemon = { close: async () => void (await runtime.close()), httpPort, token };
});

afterEach(async () => {
  await daemon.close();
});

async function rpc(method: string, params: Record<string, unknown>): Promise<RpcBody> {
  const response = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  return (await response.json()) as RpcBody;
}

const allocate = (params: Record<string, unknown>) => rpc('agent_device.lease.allocate', params);

async function allocateLease(params: Record<string, unknown>): Promise<string> {
  const allocated = await allocate(params);
  const leaseId = allocated.result?.data?.lease?.leaseId;
  expect(leaseId, JSON.stringify(allocated)).toBeTypeOf('string');
  return leaseId as string;
}

test('an allocate that repeats every lease label but sends no lease id gets no lease id back', async () => {
  const owner = { ...PROXY_SCOPE, session: 'agent-a' };
  const leaseId = await allocateLease(owner);

  const thief = await allocate({ ...owner, session: 'agent-b' });
  expect(thief.error?.data, JSON.stringify(thief)).toMatchObject({
    code: 'DEVICE_IN_USE',
    details: { reason: 'DEVICE_LEASE_BUSY' },
  });
  expect(JSON.stringify(thief)).not.toContain(leaseId);
  expect(thief.error?.data?.details?.leaseId).toBeUndefined();
});

test('an allocate that repeats the labels of a device-less lease without its id is refused too', async () => {
  const owner = { ...PLAIN_SCOPE, session: 'agent-a' };
  const leaseId = await allocateLease(owner);

  const thief = await allocate({ ...owner, session: 'agent-b' });
  expect(thief.error?.data, JSON.stringify(thief)).toMatchObject({
    code: 'DEVICE_IN_USE',
    details: { reason: 'DEVICE_LEASE_BUSY' },
  });
  expect(JSON.stringify(thief)).not.toContain(leaseId);
});

test('the owner that sends the lease id allocates its live lease again and can release it', async () => {
  const owner = { ...PROXY_SCOPE, session: 'agent-a' };
  const leaseId = await allocateLease(owner);

  const refreshed = await allocate({ ...owner, leaseId });
  expect(refreshed.result, JSON.stringify(refreshed)).toMatchObject({
    ok: true,
    data: { reused: true, lease: { leaseId } },
  });

  const released = await rpc('agent_device.lease.release', { ...owner, leaseId });
  expect(released.result?.data, JSON.stringify(released)).toMatchObject({ released: true });

  const next = await allocate(owner);
  expect(next.result?.ok, JSON.stringify(next)).toBe(true);
  expect(next.result?.data?.lease?.leaseId).not.toBe(leaseId);
});
