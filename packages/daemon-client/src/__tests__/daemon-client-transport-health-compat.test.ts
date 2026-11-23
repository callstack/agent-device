import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import { DAEMON_RPC_PROTOCOL_VERSION } from '@agent-device/contracts/daemon-http';
import { readVersion } from '@agent-device/host-kit/version';
import { readRemoteDaemonHealth } from '../daemon-client-transport.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

/**
 * ADR 0006 health compatibility across every link a command RPC crosses. `sendToDaemon`
 * runs this check before the RPC (index.test.ts pins that order); these cases pin
 * what the check itself accepts and refuses when a proxy sits in front of the daemon.
 */

const DAEMON_LINK = {
  ok: true,
  service: 'agent-device-daemon',
  version: '98.0.0',
  hostArch: 'arm64',
} as const;

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
    hostArch: 'x86_64',
    upstream: { ...DAEMON_LINK, rpcProtocolVersion: upstreamRpcProtocolVersion },
  };
}

async function readRefusal(
  payload: Record<string, unknown>,
): Promise<Error & { details?: Record<string, unknown> }> {
  return await withHealthServer(payload, (baseUrl) =>
    readRemoteDaemonHealth({ baseUrl, token: 't', pid: 0 }).then(
      () => assert.fail('expected a protocol refusal'),
      (error: unknown) => error as Error & { details?: Record<string, unknown> },
    ),
  );
}

test('a proxy whose daemon speaks the same protocol passes with the upstream link readable', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withHealthServer(proxyHealth(DAEMON_RPC_PROTOCOL_VERSION), async (baseUrl) => {
    const health = await readRemoteDaemonHealth({ baseUrl, token: 'proxy-token', pid: 0 });
    assert.equal(health.reachable, true);
    assert.equal(health.service, 'agent-device-proxy');
    assert.equal(health.hostArch, 'x86_64');
    assert.deepEqual(health.upstream, {
      service: 'agent-device-daemon',
      version: '98.0.0',
      rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
      hostArch: 'arm64',
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

test.for([
  ['an older daemon', DAEMON_RPC_PROTOCOL_VERSION - 1, false, 'remote', 'the remote host'],
  ['a newer daemon', DAEMON_RPC_PROTOCOL_VERSION + 1, false, 'client', 'this client'],
  [
    'an older daemon behind a proxy',
    DAEMON_RPC_PROTOCOL_VERSION - 1,
    true,
    'remote',
    'the agent-device-daemon behind agent-device-proxy',
  ],
  [
    'a newer daemon behind a proxy',
    DAEMON_RPC_PROTOCOL_VERSION + 1,
    true,
    'client-and-proxy',
    'this client and on agent-device-proxy',
  ],
] as const)(
  'a refusal of %s names both versions, both protocols and the side to upgrade',
  async ([_label, remoteProtocol, viaProxy, upgradeSide, upgradeTarget], t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;

    const payload = viaProxy
      ? proxyHealth(remoteProtocol)
      : { ...DAEMON_LINK, rpcProtocolVersion: remoteProtocol };
    const error = await readRefusal(payload);
    assert.equal(error.details?.upgradeSide, upgradeSide);
    assert.equal(error.details?.clientVersion, readVersion());
    assert.equal(error.details?.remoteVersion, '98.0.0');
    assert.equal(error.details?.supportedRpcProtocolVersion, DAEMON_RPC_PROTOCOL_VERSION);
    assert.equal(error.details?.remoteRpcProtocolVersion, remoteProtocol);
    assert.ok(
      error.message.includes(`${readVersion()} (RPC protocol ${DAEMON_RPC_PROTOCOL_VERSION})`),
    );
    assert.ok(error.message.includes(`98.0.0 (RPC protocol ${remoteProtocol})`));
    assert.ok(error.message.endsWith(`Upgrade agent-device on ${upgradeTarget}.`));
  },
);

test('a proxy that reports an empty service name is still named as the proxy', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const error = await readRefusal({ ...proxyHealth(DAEMON_RPC_PROTOCOL_VERSION + 1), service: '' });
  assert.equal(error.details?.upgradeSide, 'client-and-proxy');
  assert.ok(error.message.includes('the agent-device-daemon behind the proxy'));
  assert.ok(error.message.endsWith('Upgrade agent-device on this client and on the proxy.'));
});

test('a daemon health payload without an upstream link or host arch parses as before', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const { hostArch: _hostArch, ...legacyLink } = DAEMON_LINK;
  await withHealthServer(
    { ...legacyLink, rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION },
    async (baseUrl) => {
      const health = await readRemoteDaemonHealth({ baseUrl, token: 'daemon-token', pid: 0 });
      assert.equal(health.reachable, true);
      assert.equal(health.upstream, undefined);
      assert.equal('hostArch' in health, false);
      assert.equal(health.rpcProtocolVersion, DAEMON_RPC_PROTOCOL_VERSION);
    },
  );
});

test.for(['daemon', 'upstream'] as const)(
  'released protocol-2 %s cannot silently omit batch receipt delivery',
  async (link, t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;

    const payload =
      link === 'upstream' ? proxyHealth(2) : { ...DAEMON_LINK, rpcProtocolVersion: 2 };
    await withHealthServer(payload, async (baseUrl) => {
      await assert.rejects(
        readRemoteDaemonHealth({ baseUrl, token: 't', pid: 0 }),
        (error: unknown) => {
          const failure = error as { code?: string; details?: Record<string, unknown> };
          assert.equal(failure.code, 'COMMAND_FAILED');
          assert.equal(failure.details?.remoteRpcProtocolVersion, 2);
          assert.equal(failure.details?.supportedRpcProtocolVersion, DAEMON_RPC_PROTOCOL_VERSION);
          return true;
        },
      );
    });
  },
);
