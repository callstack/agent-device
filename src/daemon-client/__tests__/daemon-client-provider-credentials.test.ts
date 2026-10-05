import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import { sendToDaemon } from '../daemon-client.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import {
  currentDaemonCodeSignature,
  startHttpDaemonFixture,
} from '../../__tests__/test-utils/daemon-http-fixture.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  supportsLoopbackBind,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { providerCredentialFingerprint } from '../../provider-credential-fingerprint.ts';
import { LIMRUN_CREDENTIAL_VARIABLES } from '../../provider-limrun-credentials.ts';

const API_KEY = 'lim-secret-key';

afterEach(() => {
  vi.unstubAllEnvs();
});

type CapturedDaemon = { bodies: string[]; close: () => Promise<void> };

test.sequential.for(['socket', 'http'] as const)(
  'a local %s daemon gets a fingerprint, never the key, only on lease_allocate with credentials',
  async (transport, t) => {
    if (!(await supportsLoopbackBind())) {
      t.skip('loopback listeners are not permitted in this environment');
      return;
    }
    clearCredentialEnv();
    vi.stubEnv('AGENT_DEVICE_DAEMON_BASE_URL', undefined);
    vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', undefined);
    const stateDir = mkdtempForTestSync('agent-device-provider-credentials-daemon-');
    const daemon = await startLocalDaemon(stateDir, transport);
    const send = (command: string) =>
      sendToDaemon({
        session: 'default',
        command,
        positionals: [],
        flags: { stateDir, daemonTransport: transport },
        meta: { requestId: `req-${command}`, leaseProvider: 'limrun', tenantId: 'tenant-a' },
      });

    try {
      vi.stubEnv('LIMRUN_API_KEY', API_KEY);
      await send('lease_allocate');
      await send('devices');
      vi.stubEnv('LIMRUN_API_KEY', undefined);
      await send('lease_allocate');
    } finally {
      await daemon.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    expect(daemon.bodies.map(readFingerprint)).toEqual([
      providerCredentialFingerprint('limrun', { LIMRUN_API_KEY: API_KEY }),
      undefined,
      undefined,
    ]);
    for (const body of daemon.bodies) expect(body).not.toContain(API_KEY);
  },
);

test.sequential('a remote daemon gets no provider credential fingerprint', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  clearCredentialEnv();
  vi.stubEnv('LIMRUN_API_KEY', API_KEY);
  const remote = await startHttpDaemonFixture({});
  vi.stubEnv('AGENT_DEVICE_DAEMON_BASE_URL', `http://127.0.0.1:${remote.port}`);
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'remote-secret');

  try {
    await sendToDaemon({
      session: 'default',
      command: 'lease_allocate',
      positionals: [],
      meta: { requestId: 'req-remote-lease', leaseProvider: 'limrun', tenantId: 'tenant-a' },
    });
  } finally {
    await closeLoopbackServer(remote.server);
  }

  expect(remote.rpcRequests.map((rpc) => rpc.method)).toEqual(['agent_device.lease.allocate']);
  const body = JSON.stringify(remote.rpcRequests[0]);
  expect(readFingerprint(body)).toBe(undefined);
  expect(body).not.toContain(API_KEY);
});

function readFingerprint(body: string): unknown {
  const parsed = JSON.parse(body) as {
    meta?: { providerCredentialFingerprint?: unknown };
    params?: { providerCredentialFingerprint?: unknown; meta?: Record<string, unknown> };
  };
  return (
    parsed.meta?.providerCredentialFingerprint ??
    parsed.params?.providerCredentialFingerprint ??
    parsed.params?.meta?.providerCredentialFingerprint
  );
}

function clearCredentialEnv(): void {
  for (const name of LIMRUN_CREDENTIAL_VARIABLES) vi.stubEnv(name, undefined);
}

async function startLocalDaemon(
  stateDir: string,
  transport: 'socket' | 'http',
): Promise<CapturedDaemon> {
  if (transport === 'http') {
    const daemon = await startHttpDaemonFixture({});
    writeDaemonInfo(stateDir, { httpPort: daemon.port, transport });
    return {
      get bodies() {
        return daemon.rpcRequests.map((rpc) => JSON.stringify(rpc));
      },
      close: () => closeLoopbackServer(daemon.server),
    };
  }
  const bodies: string[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let body = '';
    socket.on('data', (chunk) => {
      body += chunk;
      if (!body.includes('\n')) return;
      bodies.push(body.trim());
      socket.end(`${JSON.stringify({ ok: true, data: {} })}\n`);
    });
  });
  writeDaemonInfo(stateDir, { port: await listenOnLoopback(server), transport });
  return { bodies, close: () => closeLoopbackServer(server) };
}

function writeDaemonInfo(stateDir: string, endpoint: Record<string, unknown>): void {
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    `${JSON.stringify({
      ...endpoint,
      token: 'local-secret',
      pid: process.pid,
      version: readVersion(),
      codeSignature: currentDaemonCodeSignature(),
      processStartTime: readProcessStartTime(process.pid) ?? undefined,
    })}\n`,
    'utf8',
  );
}
