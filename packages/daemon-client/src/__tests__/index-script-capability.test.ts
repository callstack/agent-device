import http from 'node:http';
import path from 'node:path';
import { expect, test } from 'vitest';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { sendToDaemon } from '../index.ts';

test.each([
  { name: 'legacy daemon', health: {}, supported: false },
  {
    name: 'upgraded proxy with legacy daemon',
    health: { capabilities: ['active-script-artifacts'], upstream: {} },
    supported: false,
  },
  {
    name: 'upgraded daemon',
    health: { capabilities: ['active-script-artifacts'] },
    supported: true,
  },
  {
    name: 'forwarding proxy with upgraded daemon',
    health: { upstream: { capabilities: ['active-script-artifacts'] } },
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
        details: { reason: 'remote_active_script_artifacts_unsupported', daemonRequestSent: false },
      });
    expect(rpcCount).toBe(supported ? 1 : 0);
  } finally {
    await closeLoopbackServer(server);
  }
});
