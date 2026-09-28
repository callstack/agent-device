import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import { DAEMON_RPC_PROTOCOL_VERSION } from '@agent-device/contracts/daemon-http';
import { sendToDaemon } from '../daemon-client.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';

test('persistent remote client probes once per identity and probes again after transport failure', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const paths: string[] = [];
  let failRpc = false;
  let rpcProtocolVersion: number = DAEMON_RPC_PROTOCOL_VERSION;
  let instanceId = 'first-instance';
  let legacy = false;
  let omitInstanceHeader = false;
  const server = http.createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith('/health')) {
      res.end(
        JSON.stringify({
          ok: true,
          service: 'agent-device-daemon',
          version: '1.0.0',
          rpcProtocolVersion,
          ...(legacy ? {} : { instanceId }),
        }),
      );
      return;
    }
    if (failRpc) {
      req.socket.destroy();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (!legacy && !omitInstanceHeader) res.setHeader('x-agent-device-instance', instanceId);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'request', result: { ok: true, data: {} } }));
  });
  try {
    const port = await listenOnLoopback(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const request = (token: string, url = baseUrl) =>
      sendToDaemon(
        {
          command: 'remote-smoke',
          session: 'default',
          positionals: ['ping'],
          flags: { daemonBaseUrl: url },
          meta: { requestId: 'request' },
        },
        { authToken: token },
      );
    assert.equal((await request('first')).ok, true);
    assert.equal((await request('first')).ok, true);
    assert.deepEqual(paths, ['GET /health', 'POST /rpc', 'POST /rpc']);

    assert.equal((await request('second')).ok, true);
    assert.deepEqual(paths.slice(3), ['GET /health', 'POST /rpc']);

    failRpc = true;
    await assert.rejects(request('second'));
    failRpc = false;
    rpcProtocolVersion = DAEMON_RPC_PROTOCOL_VERSION + 1;
    await assert.rejects(request('second'), /RPC protocol is incompatible/);
    assert.deepEqual(paths.slice(5), ['POST /rpc', 'GET /health']);
    rpcProtocolVersion = DAEMON_RPC_PROTOCOL_VERSION;
    assert.equal((await request('second')).ok, true);
    assert.deepEqual(paths.slice(7), ['GET /health', 'POST /rpc']);

    assert.equal((await request('second', `${baseUrl}/alt`)).ok, true);
    assert.deepEqual(paths.slice(9), ['GET /alt/health', 'POST /alt/rpc']);

    instanceId = 'replacement-instance';
    assert.equal((await request('second', `${baseUrl}/alt`)).ok, true);
    assert.deepEqual(paths.slice(11), ['POST /alt/rpc', 'GET /alt/health']);
    assert.equal((await request('second', `${baseUrl}/alt`)).ok, true);
    assert.deepEqual(paths.slice(13), ['POST /alt/rpc']);

    instanceId = 'incompatible-instance';
    rpcProtocolVersion = DAEMON_RPC_PROTOCOL_VERSION + 1;
    await assert.rejects(request('second', `${baseUrl}/alt`), /RPC protocol is incompatible/);
    assert.deepEqual(paths.slice(14), ['POST /alt/rpc', 'GET /alt/health']);

    legacy = true;
    rpcProtocolVersion = DAEMON_RPC_PROTOCOL_VERSION;
    assert.equal((await request('legacy')).ok, true);
    assert.equal((await request('legacy')).ok, true);
    assert.deepEqual(paths.slice(16), ['GET /health', 'POST /rpc', 'GET /health', 'POST /rpc']);

    legacy = false;
    assert.equal((await request('modern')).ok, true);
    omitInstanceHeader = true;
    assert.equal((await request('modern')).ok, true);
    assert.equal((await request('modern')).ok, true);
    assert.deepEqual(paths.slice(20), [
      'GET /health',
      'POST /rpc',
      'POST /rpc',
      'GET /health',
      'GET /health',
      'POST /rpc',
      'GET /health',
    ]);
  } finally {
    await closeLoopbackServer(server);
  }
});
