import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import { DAEMON_RPC_PROTOCOL_VERSION } from '@agent-device/contracts/daemon-http';
import { readRemoteDaemonHealth } from '../daemon-client-transport.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../__tests__/test-utils/loopback.ts';

/**
 * ADR 0006 health compatibility across every link a command RPC crosses. `sendToDaemon`
 * runs this check before the RPC (daemon-client.test.ts pins that order); these cases pin
 * what the check itself accepts and refuses when a proxy sits in front of the daemon.
 */

const DAEMON_LINK = { ok: true, service: 'agent-device-daemon', version: '98.0.0' } as const;

async function withHealthServer<T>(
  payload: Record<string, unknown>,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/agent-device/health');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  try {
    const port = await listenOnLoopback(server);
    return await run(`http://127.0.0.1:${port}/agent-device`);
  } finally {
    await closeLoopbackServer(server);
  }
}

function proxyHealth(upstreamRpcProtocolVersion: number): Record<string, unknown> {
  return {
    ok: true,
    service: 'agent-device-proxy',
    version: '99.0.0',
    rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    upstream: { ...DAEMON_LINK, rpcProtocolVersion: upstreamRpcProtocolVersion },
  };
}

test('a proxy whose daemon speaks the same protocol passes with the upstream link readable', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withHealthServer(proxyHealth(DAEMON_RPC_PROTOCOL_VERSION), async (baseUrl) => {
    const health = await readRemoteDaemonHealth({ baseUrl, token: 'proxy-token', pid: 0 });
    assert.equal(health.reachable, true);
    assert.equal(health.service, 'agent-device-proxy');
    assert.deepEqual(health.upstream, {
      service: 'agent-device-daemon',
      version: '98.0.0',
      rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    });
  });
});

test('a proxy whose daemon speaks another protocol is refused, naming the daemon link', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withHealthServer(proxyHealth(DAEMON_RPC_PROTOCOL_VERSION + 1), async (baseUrl) => {
    await assert.rejects(
      readRemoteDaemonHealth({ baseUrl, token: 'proxy-token', pid: 0 }),
      (error: unknown) => {
        const details = (error as { code?: string; details?: Record<string, unknown> }).details;
        assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
        assert.match(String((error as Error).message), /RPC protocol is incompatible/);
        assert.equal(details?.remoteService, 'agent-device-daemon');
        assert.equal(details?.remoteVersion, '98.0.0');
        assert.equal(details?.remoteRpcProtocolVersion, DAEMON_RPC_PROTOCOL_VERSION + 1);
        assert.equal(details?.supportedRpcProtocolVersion, DAEMON_RPC_PROTOCOL_VERSION);
        return true;
      },
    );
  });
});

test('a daemon health payload without an upstream link parses as before', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withHealthServer(
    { ...DAEMON_LINK, rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION },
    async (baseUrl) => {
      const health = await readRemoteDaemonHealth({ baseUrl, token: 'daemon-token', pid: 0 });
      assert.equal(health.reachable, true);
      assert.equal(health.upstream, undefined);
      assert.equal(health.rpcProtocolVersion, DAEMON_RPC_PROTOCOL_VERSION);
    },
  );
});
