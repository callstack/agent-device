import http from 'node:http';
import path from 'node:path';
import { expect, test } from 'vitest';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { DAEMON_HTTP_INSTANCE_MISMATCH_HEADER } from '@agent-device/contracts/daemon-http';
import { sendToDaemon } from '../index.ts';

test.each([
  { name: 'legacy daemon', health: {}, supported: false },
  {
    name: 'upgraded proxy with legacy daemon',
    health: { capabilities: ['script-artifacts'], upstream: {} },
    supported: false,
  },
  {
    name: 'upgraded daemon',
    health: { capabilities: ['script-artifacts'] },
    supported: true,
  },
  {
    name: 'forwarding proxy with upgraded daemon',
    health: { upstream: { capabilities: ['script-artifacts'] } },
    supported: true,
  },
])('remote recording negotiates $name before dispatch', async ({ health, supported }) => {
  let rpcCount = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true, ...health }));
      return;
    }
    rpcCount += 1;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'test', result: { ok: true, data: {} } }));
  });
  const root = mkdtempForTestSync('script-capability-');
  try {
    const result = sendToDaemon(
      {
        command: 'open',
        session: 'owned',
        positionals: ['Demo'],
        flags: {
          daemonBaseUrl: `http://127.0.0.1:${await listenOnLoopback(server)}`,
          saveScript: path.join(root, 'journey.ad'),
          stateDir: path.join(root, 'state'),
        },
      },
      { authToken: 'test' },
    );
    if (supported) await expect(result).resolves.toMatchObject({ ok: true });
    else
      await expect(result).rejects.toMatchObject({
        code: 'INVALID_ARGS',
        details: { reason: 'remote_script_artifacts_unsupported', daemonRequestSent: false },
      });
    expect(rpcCount).toBe(supported ? 1 : 0);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a remote recording is not resent to a replacement daemon that cannot deliver scripts', async () => {
  let rpcCount = 0;
  let replaced = false;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      const health = replaced
        ? { instanceId: 'legacy' }
        : { instanceId: 'capable', capabilities: ['script-artifacts'] };
      res.end(JSON.stringify({ ok: true, ...health }));
      return;
    }
    rpcCount += 1;
    replaced = true;
    res.statusCode = 409;
    res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'test', error: { code: -32000, message: 'x' } }));
  });
  const root = mkdtempForTestSync('script-capability-retry-');
  try {
    const result = sendToDaemon(
      {
        command: 'open',
        session: 'owned',
        positionals: ['Demo'],
        flags: {
          daemonBaseUrl: `http://127.0.0.1:${await listenOnLoopback(server)}`,
          saveScript: path.join(root, 'journey.ad'),
          stateDir: path.join(root, 'state'),
        },
      },
      { authToken: 'test' },
    );
    await expect(result).rejects.toMatchObject({
      details: { reason: 'remote_script_artifacts_unsupported', daemonRequestSent: false },
    });
    expect(rpcCount).toBe(1);
  } finally {
    await closeLoopbackServer(server);
  }
});
