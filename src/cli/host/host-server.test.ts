import { test, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { createHostServer, type HostTlsMaterial } from './host-server.ts';
import { prepareHostServiceCredential } from './service-credential.ts';

const UPSTREAM_TOKEN = 'daemon-token-never-leaves-host';

type UpstreamCall = { url: string; authorization: string | undefined; body: string };

async function startUpstreamDaemon(t: TestContext) {
  const calls: UpstreamCall[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push({ url: req.url ?? '', authorization: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true, data: {} } }));
    });
  });
  const port = await listenOnLoopback(server);
  t.onTestFinished(() => closeLoopbackServer(server));
  return { calls, upstreamBaseUrl: `http://127.0.0.1:${port}` };
}

async function startHost(
  t: TestContext,
  options: { upstreamBaseUrl: string; hostDir: string; tls?: HostTlsMaterial },
) {
  const prepared = prepareHostServiceCredential(options.hostDir);
  prepared.publish();
  const { credential } = prepared;
  const server = createHostServer({
    upstreamBaseUrl: options.upstreamBaseUrl,
    upstreamToken: UPSTREAM_TOKEN,
    credential,
    tls: options.tls,
  });
  const port = await listenOnLoopback(server);
  t.onTestFinished(() => closeLoopbackServer(server));
  return { token: credential.token, server, port, baseUrl: `http://127.0.0.1:${port}` };
}

test('host answers unserved routes with 404', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const upstream = await startUpstreamDaemon(t);
  const host = await startHost(t, {
    upstreamBaseUrl: upstream.upstreamBaseUrl,
    hostDir: path.join(mkdtempForTestSync('agent-device-host-'), 'host'),
  });
  const authorization = `Bearer ${host.token}`;

  for (const route of ['/agent-device/nope', '/admin/leases', '/']) {
    const response = await fetch(`${host.baseUrl}${route}`, { headers: { authorization } });
    assert.equal(response.status, 404, route);
  }
  assert.equal(upstream.calls.length, 0);
});

function generateSelfSignedCertificate(dir: string): HostTlsMaterial | undefined {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  try {
    const subject = ['-subj', '/CN=127.0.0.1', '-keyout', keyPath, '-out', certPath];
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', ...subject],
      { stdio: 'ignore' },
    );
  } catch {
    return undefined;
  }
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

test('host serves HTTPS when given a certificate and key', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const dir = mkdtempForTestSync('agent-device-host-tls-');
  const tls = generateSelfSignedCertificate(dir);
  if (!tls) {
    t.skip('openssl is not available to generate a test certificate');
    return;
  }
  const upstream = await startUpstreamDaemon(t);
  const host = await startHost(t, {
    upstreamBaseUrl: upstream.upstreamBaseUrl,
    hostDir: path.join(dir, 'host'),
    tls,
  });

  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: host.port,
        path: '/agent-device/rpc',
        method: 'POST',
        rejectUnauthorized: false,
        headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent_device.command', params: {} }));
  });

  assert.equal(status, 200);
  assert.equal(upstream.calls.length, 1);
});
