import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DAEMON_RPC_PROTOCOL_VERSION } from '../../src/daemon/http-health.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../src/__tests__/test-utils/loopback.ts';
import { formatResultDebug, runBuiltCliJson } from './cli-json.ts';

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

test('built CLI provider flow closes active generated session before disconnect cleanup', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'provider disconnect smoke coverage')) {
    return;
  }

  const fixture = await createProviderDaemonFixture(t);
  const env = createProviderEnv();
  const activeSession = await connectBrowserStackProvider(fixture, env);
  await openProviderApp(fixture, env);
  await disconnectProviderSession(fixture, env, activeSession);
  assertProviderDisconnectRpc(fixture.rpcRequests, activeSession);
  await assertNoActiveConnection(fixture, env);
});

type ProviderDaemonFixture = {
  root: string;
  stateDir: string;
  daemonBaseUrl: string;
  rpcRequests: any[];
};

async function createProviderDaemonFixture(t: TestContext): Promise<ProviderDaemonFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-provider-disconnect-smoke-'));
  const stateDir = path.join(root, 'state');
  const rpcRequests: any[] = [];
  let hostPort = 0;
  const hostServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/agent-device/health') {
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
      });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'agent-device-daemon',
          version: '0.0.0-test',
          rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/agent-device/rpc') {
      const body = await readJsonBody(req);
      rpcRequests.push(body);
      const data = responseDataForRpc(body);
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body?.id ?? 'provider-disconnect-smoke',
          result: {
            ok: true,
            data,
          },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });
  hostPort = await listenOnLoopback(hostServer);
  t.after(async () => {
    await closeLoopbackServer(hostServer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    stateDir,
    daemonBaseUrl: `http://127.0.0.1:${hostPort}/agent-device`,
    rpcRequests,
  };
}

function createProviderEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BROWSERSTACK_USERNAME: 'browser-user',
    BROWSERSTACK_ACCESS_KEY: 'browser-key',
  };
}

async function connectBrowserStackProvider(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const connectArgs = [
    'connect',
    'browserstack',
    '--platform',
    'android',
    '--device',
    'Google Pixel 8',
    '--provider-os-version',
    '14.0',
    '--provider-app',
    'bs://app-id',
    '--daemon-base-url',
    fixture.daemonBaseUrl,
    '--state-dir',
    fixture.stateDir,
    '--json',
  ];
  const connectResult = await runBuiltCliJson(connectArgs, env);

  assert.equal(connectResult.status, 0, formatResultDebug('connect', connectArgs, connectResult));
  assert.equal(
    connectResult.json?.success,
    true,
    formatResultDebug('connect', connectArgs, connectResult),
  );
  const activeSession = connectResult.json?.data?.session;
  assert.match(activeSession, /^adc-/);
  return activeSession;
}

async function openProviderApp(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const openArgs = ['open', 'Demo', '--state-dir', fixture.stateDir, '--json'];
  const openResult = await runBuiltCliJson(openArgs, env);
  assert.equal(openResult.status, 0, formatResultDebug('open', openArgs, openResult));
  assert.equal(openResult.json?.success, true, formatResultDebug('open', openArgs, openResult));
}

async function disconnectProviderSession(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
  activeSession: string,
): Promise<void> {
  const disconnectArgs = ['disconnect', '--state-dir', fixture.stateDir, '--json'];
  const disconnectResult = await runBuiltCliJson(disconnectArgs, env);
  assert.equal(
    disconnectResult.status,
    0,
    formatResultDebug('disconnect', disconnectArgs, disconnectResult),
  );
  assert.equal(
    disconnectResult.json?.success,
    true,
    formatResultDebug('disconnect', disconnectArgs, disconnectResult),
  );
  assert.equal(disconnectResult.json?.data?.session, activeSession);
  assert.equal(disconnectResult.json?.data?.released, true);
}

function assertProviderDisconnectRpc(rpcRequests: any[], activeSession: string): void {
  const closeRpc = rpcRequests.find(
    (request) => request.method === 'agent_device.command' && request.params?.command === 'close',
  );
  assert.equal(closeRpc?.params?.session, activeSession);
  assert.notEqual(closeRpc?.params?.session, 'default');

  const releaseRpc = rpcRequests.find((request) => request.method === 'agent_device.lease.release');
  assert.equal(releaseRpc?.params?.session, activeSession);
  assert.equal(releaseRpc?.params?.leaseId, 'lease-bs-1');
  assert.equal(releaseRpc?.params?.leaseProvider, 'browserstack');
}

async function assertNoActiveConnection(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const statusArgs = ['connection', 'status', '--state-dir', fixture.stateDir, '--json'];
  const statusResult = await runBuiltCliJson(statusArgs, env);
  assert.equal(statusResult.status, 0, formatResultDebug('status', statusArgs, statusResult));
  assert.equal(
    statusResult.json?.success,
    true,
    formatResultDebug('status', statusArgs, statusResult),
  );
  assert.equal(statusResult.json?.data?.connected, false);
}

function responseDataForRpc(body: any): Record<string, unknown> {
  const params = body?.params ?? {};
  if (body?.method === 'agent_device.lease.allocate') {
    return {
      lease: {
        leaseId: 'lease-bs-1',
        tenantId: params.tenantId,
        runId: params.runId,
        backend: params.backend,
        leaseProvider: params.leaseProvider,
        clientId: params.clientId,
        deviceKey: params.deviceKey,
      },
    };
  }
  if (body?.method === 'agent_device.lease.release') {
    return {
      released: true,
      provider: {
        provider: 'browserstack',
        providerSessionId: 'bs-session-1',
      },
    };
  }
  if (params.command === 'open') {
    return {
      session: params.session,
      appName: 'Demo',
      appBundleId: 'com.example.demo',
      platform: 'android',
      target: 'mobile',
      device: 'Pixel',
      id: 'browserstack-pixel',
      serial: 'browserstack-pixel',
    };
  }
  if (params.command === 'close') {
    return {
      provider: {
        provider: 'browserstack',
        providerSessionId: 'bs-session-1',
      },
    };
  }
  return {};
}
