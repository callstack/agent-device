import fs from 'node:fs';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

const TENANT = 'tenant-a';
const RUN = 'run-1';
const PROXY_SCOPE = {
  tenantId: TENANT,
  runId: RUN,
  leaseProvider: 'proxy',
  clientId: 'client-a',
  deviceKey: 'android:mobile:emulator-5554',
  backend: 'android-instance',
} as const;

type RpcBody = {
  result?: { ok?: boolean; data?: { lease?: { leaseId?: string } } };
  error?: { data?: { code?: string; details?: { reason?: string; leaseProvider?: string } } };
};

let daemon: { close: () => Promise<void>; httpPort: number; token: string };

beforeEach(async () => {
  const stateDir = mkdtempForTestSync('agent-device-leased-session-');
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
  daemon = {
    close: async () => {
      await runtime.close();
    },
    httpPort,
    token,
  };
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

function allocate(params: Record<string, unknown>): Promise<RpcBody> {
  return rpc('agent_device.lease.allocate', params);
}

async function allocateNamedLease(session: string): Promise<string> {
  const allocated = await allocate({ ...PROXY_SCOPE, session });
  const leaseId = allocated.result?.data?.lease?.leaseId;
  expect(leaseId, JSON.stringify(allocated)).toBeTypeOf('string');
  return leaseId as string;
}

function expectSessionRequired(body: RpcBody): void {
  expect(body.error?.data).toMatchObject({
    code: 'INVALID_ARGS',
    details: { reason: 'REMOTE_SESSION_REQUIRED', leaseProvider: 'proxy' },
  });
}

test.each([
  ['omitted', {}],
  ['blank', { session: '  ' }],
])('a %s session is refused before a provider lease is allocated', async (_label, session) => {
  expectSessionRequired(await allocate({ ...PROXY_SCOPE, ...session }));

  // Another client finds the device free, so the refused request left no lease behind.
  const other = await allocate({ ...PROXY_SCOPE, clientId: 'client-b', session: 'agent-b' });
  expect(other.result?.ok, JSON.stringify(other)).toBe(true);
});

test('a client that names no session is refused before a provider lease is allocated', async () => {
  const { backend: leaseBackend, ...scope } = PROXY_SCOPE;

  const refused = await rpc('agent_device.command', {
    session: 'default',
    command: 'lease_allocate',
    positionals: [],
    meta: { ...scope, leaseBackend, sessionExplicit: false },
  });

  expectSessionRequired(refused);
  const other = await allocate({ ...PROXY_SCOPE, clientId: 'client-b', session: 'agent-b' });
  expect(other.result?.ok, JSON.stringify(other)).toBe(true);
});

test.each([
  ['in its meta', { sessionExplicit: true }, {}],
  ['in its flags', { sessionExplicit: false }, { session: 'default' }],
])('a client that names the default session %s is not refused', async (_label, meta, flags) => {
  const { backend: leaseBackend, ...scope } = PROXY_SCOPE;

  const allocated = await rpc('agent_device.command', {
    session: 'default',
    command: 'lease_allocate',
    positionals: [],
    flags,
    meta: { ...scope, leaseBackend, ...meta },
  });

  expect(allocated.result?.ok, JSON.stringify(allocated)).toBe(true);
});

test('an unnamed heartbeat is refused and the named lease stays usable', async () => {
  const leaseId = await allocateNamedLease('agent-a');

  expectSessionRequired(await rpc('agent_device.lease.heartbeat', { ...PROXY_SCOPE, leaseId }));

  const named = await rpc('agent_device.lease.heartbeat', {
    ...PROXY_SCOPE,
    leaseId,
    session: 'agent-a',
  });
  expect(named.result?.ok).toBe(true);
});

test('an unnamed release is refused and the lease is still released when named', async () => {
  const leaseId = await allocateNamedLease('agent-a');

  expectSessionRequired(await rpc('agent_device.lease.release', { ...PROXY_SCOPE, leaseId }));

  const named = await rpc('agent_device.lease.release', {
    ...PROXY_SCOPE,
    leaseId,
    session: 'agent-a',
  });
  expect(named.result?.data).toMatchObject({ released: true });
});

test.each([
  ['shared', {}],
  ['tenant-isolated', { sessionIsolation: 'tenant' }],
])(
  'an unnamed leased command is refused for its session in a %s daemon',
  async (_label, isolation) => {
    const leaseId = await allocateNamedLease('agent-a');
    const { backend: leaseBackend, ...scope } = PROXY_SCOPE;

    const refused = await rpc('agent_device.command', {
      command: 'snapshot',
      positionals: [],
      meta: { ...scope, leaseBackend, leaseId, ...isolation },
    });

    expectSessionRequired(refused);
  },
);

test('a named leased command is not refused for its session', async () => {
  const leaseId = await allocateNamedLease('agent-a');
  const { backend: leaseBackend, ...scope } = PROXY_SCOPE;

  const named = await rpc('agent_device.command', {
    session: 'agent-a',
    command: 'snapshot',
    positionals: [],
    meta: { ...scope, leaseBackend, leaseId },
  });

  expect(named.error?.data?.code, JSON.stringify(named)).toBe('DEVICE_NOT_FOUND');
  expect(named.error?.data?.details?.reason).not.toBe('REMOTE_SESSION_REQUIRED');
});

test('an unnamed request that names a provider but holds no lease is not refused for its session', async () => {
  const listed = await rpc('agent_device.command', {
    command: 'apps',
    positionals: [],
    flags: { platform: 'android', leaseProvider: 'proxy' },
  });

  expect(listed.error?.data?.details?.reason).not.toBe('REMOTE_SESSION_REQUIRED');
});

test('requests with no lease provider keep their unnamed default session', async () => {
  const allocated = await allocate({
    tenantId: TENANT,
    runId: RUN,
    backend: 'android-instance',
  });
  expect(allocated.result?.ok, JSON.stringify(allocated)).toBe(true);

  const listed = await rpc('agent_device.command', { command: 'session_list' });
  expect(listed.result?.ok, JSON.stringify(listed)).toBe(true);
});
