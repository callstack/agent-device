import { test, vi, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { createTestClient } from '../../__tests__/remote-connection.fixtures.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { ensureDaemon } from '../../daemon-client/daemon-client-lifecycle.ts';
import { hostCommand } from './host.ts';

const servedHosts = vi.hoisted(() => [] as net.Server[]);

vi.mock('../../daemon-client/daemon-client-lifecycle.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../daemon-client/daemon-client-lifecycle.ts')>()),
  ensureDaemon: vi.fn(),
}));

vi.mock('../host/local-daemon.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../host/local-daemon.ts')>();
  return {
    ...original,
    listenOnTcp: async (server: net.Server, bind: { host: string; port: number }) => {
      servedHosts.push(server);
      return await original.listenOnTcp(server, bind);
    },
    waitForever: async () => {},
  };
});

const DAEMON_TOKEN = 'daemon-token-never-leaves-host';

function startHost(stateDir: string, extraFlags: Record<string, string> = {}) {
  return hostCommand({
    positionals: [],
    flags: { json: true, help: false, version: false, stateDir, ...extraFlags },
    client: createTestClient(),
  });
}

async function refusalBeforeDaemon(run: Promise<unknown>): Promise<unknown> {
  vi.mocked(ensureDaemon).mockClear();
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    assert.equal(vi.mocked(ensureDaemon).mock.calls.length, 0, 'no daemon starts');
    return error.details?.reason;
  }
  assert.fail('expected host to refuse to start');
}

function tlsFiles(stateDir: string) {
  const hostTlsCert = path.join(stateDir, 'cert.pem');
  const hostTlsKey = path.join(stateDir, 'key.pem');
  fs.writeFileSync(hostTlsCert, 'not a certificate\n');
  fs.writeFileSync(hostTlsKey, 'not a key\n', { mode: 0o600 });
  return { hostTlsCert, hostTlsKey };
}

test('a malformed or insecure credential stops host before any daemon starts', async () => {
  for (const mode of [0o600, 0o644]) {
    const stateDir = mkdtempForTestSync('agent-device-host-start-');
    const hostDir = path.join(stateDir, 'host');
    fs.mkdirSync(hostDir, { mode: 0o700 });
    const file = path.join(hostDir, 'service-credential.json');
    fs.writeFileSync(file, '{}\n', { mode });
    fs.chmodSync(file, mode);

    const expected = mode === 0o600 ? 'host-credential-invalid' : 'host-credential-insecure';
    assert.equal(await refusalBeforeDaemon(startHost(stateDir)), expected);
  }
});

test('TLS problems are typed refusals before any daemon starts', async () => {
  const cases: Array<[string, (stateDir: string) => Record<string, string>]> = [
    ['host-tls-incomplete', (stateDir) => ({ hostTlsCert: path.join(stateDir, 'cert.pem') })],
    [
      'host-tls-unreadable',
      (stateDir) => ({
        hostTlsCert: path.join(stateDir, 'missing-cert.pem'),
        hostTlsKey: path.join(stateDir, 'missing-key.pem'),
      }),
    ],
    ['host-tls-invalid', tlsFiles],
    ['host-tls-required', () => ({ proxyHost: '0.0.0.0' })],
  ];
  for (const [reason, flags] of cases) {
    const stateDir = mkdtempForTestSync('agent-device-host-start-');
    assert.equal(await refusalBeforeDaemon(startHost(stateDir, flags(stateDir))), reason, reason);
  }
});

async function startServingHost(t: TestContext, stateDir: string) {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await startHost(stateDir);
    return JSON.parse(String(output.mock.calls.at(-1)?.[0])).data;
  } finally {
    output.mockRestore();
    for (const server of servedHosts.splice(0)) t.onTestFinished(() => closeLoopbackServer(server));
  }
}

function rpc(baseUrl: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent_device.command', params: {} }),
  });
}

test('a started host serves health and forwards with the daemon token, also after a restart', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const daemonAuthorizations: Array<string | undefined> = [];
  const daemon = http.createServer((req, res) => {
    if (req.url?.endsWith('/rpc')) daemonAuthorizations.push(req.headers.authorization);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true, data: {} } }));
  });
  const httpPort = await listenOnLoopback(daemon);
  t.onTestFinished(() => closeLoopbackServer(daemon));
  vi.mocked(ensureDaemon).mockResolvedValue({ info: { httpPort, token: DAEMON_TOKEN } } as never);
  const stateDir = mkdtempForTestSync('agent-device-host-start-');

  const first = await startServingHost(t, stateDir);
  const restarted = await startServingHost(t, stateDir);
  const health = await fetch(`${restarted.agentDeviceBaseUrl}/health`);

  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assert.equal(restarted.token, undefined, 'the token shows only on the start that creates it');
  assert.equal((await rpc(restarted.agentDeviceBaseUrl, 'not-the-service-token')).status, 401);
  assert.equal((await rpc(restarted.agentDeviceBaseUrl, first.token)).status, 200);
  assert.deepEqual(daemonAuthorizations, [`Bearer ${DAEMON_TOKEN}`]);
});
