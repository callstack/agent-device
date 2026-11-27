import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from 'vitest';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import { assertRemoteServesCheckedRpc, sendToDaemon } from '../index.ts';

type Seen = { method: string; url: string; protocol: string | undefined };
type Answer = { status?: number; headers?: Record<string, string>; body: string };

const OK_ANSWER: Answer = {
  body: JSON.stringify({ jsonrpc: '2.0', id: 'test', result: { ok: true, data: {} } }),
};

/** A remote daemon that records every request and answers RPCs with `answer`. */
async function remoteDaemon(answer: Answer = OK_ANSWER) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const protocol = req.headers[DAEMON_HTTP_RPC_PROTOCOL_HEADER];
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      protocol: typeof protocol === 'string' ? protocol : undefined,
    });
    req.resume();
    req.on('end', () => {
      if (req.url === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ ok: true, service: 'agent-device-daemon', rpcProtocolVersion: 3 }),
        );
        return;
      }
      res.statusCode = answer.status ?? 200;
      for (const [name, value] of Object.entries(answer.headers ?? {})) res.setHeader(name, value);
      res.end(answer.body);
    });
  });
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  return { seen, baseUrl, close: () => closeLoopbackServer(server) };
}

function sessionList(baseUrl: string, flags: Record<string, unknown> = {}) {
  return {
    session: 'default',
    command: 'session',
    positionals: ['list'],
    flags: { daemonBaseUrl: baseUrl, ...flags },
  };
}

const routes = (seen: Seen[]) => seen.map(({ method, url }) => `${method} ${url}`);

test('without daemonRpc a remote command probes /health first, exactly as before', async () => {
  const daemon = await remoteDaemon();
  try {
    await expect(sendToDaemon(sessionList(daemon.baseUrl))).resolves.toMatchObject({ ok: true });
    expect(routes(daemon.seen)).toEqual(['GET /health', 'POST /rpc']);
    expect(daemon.seen[1]?.protocol).toBeUndefined();
  } finally {
    await daemon.close();
  }
});

test('with daemonRpc checked a standalone command takes one checked request', async () => {
  const daemon = await remoteDaemon();
  try {
    await expect(
      sendToDaemon(sessionList(daemon.baseUrl, { daemonRpc: 'checked' })),
    ).resolves.toMatchObject({ ok: true });
    expect(routes(daemon.seen)).toEqual(['POST /rpc/checked']);
    expect(daemon.seen[0]?.protocol).toBe(String(DAEMON_RPC_PROTOCOL_VERSION));
  } finally {
    await daemon.close();
  }
});

test('a leased command under checked RPC sends no lease beat ahead of its one request', async () => {
  const daemon = await remoteDaemon();
  try {
    await sendToDaemon(sessionList(daemon.baseUrl, { daemonRpc: 'checked', leaseId: 'lease-1' }));
    expect(routes(daemon.seen)).toEqual(['POST /rpc/checked']);
  } finally {
    await daemon.close();
  }
});

test('an install keeps the /health probe and /rpc even when checked RPC is on', async () => {
  const daemon = await remoteDaemon();
  try {
    await sendToDaemon({
      session: 'default',
      command: 'install',
      positionals: ['com.example.app', 'remote:/tmp/app.apk'],
      flags: { daemonBaseUrl: daemon.baseUrl, daemonRpc: 'checked', platform: 'android' },
    });
    expect(routes(daemon.seen)).toEqual(['GET /health', 'POST /rpc']);
  } finally {
    await daemon.close();
  }
});

test('a route miss under checked RPC fails typed and is never resent', async () => {
  const daemon = await remoteDaemon({ status: 404, body: 'Not found' });
  try {
    await expect(
      sendToDaemon(sessionList(daemon.baseUrl, { daemonRpc: 'checked' })),
    ).rejects.toMatchObject({
      details: { reason: 'remote_checked_rpc_unsupported', dispatched: 'unknown' },
    });
    expect(routes(daemon.seen)).toEqual(['POST /rpc/checked']);
  } finally {
    await daemon.close();
  }
});

test('a JSON-RPC 404 under checked RPC is the daemon answer, not a route miss', async () => {
  const daemon = await remoteDaemon({
    status: 404,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'test',
      error: {
        code: -32000,
        message: 'gone',
        data: { code: 'SESSION_NOT_FOUND', message: 'gone' },
      },
    }),
  });
  try {
    await expect(
      sendToDaemon(sessionList(daemon.baseUrl, { daemonRpc: 'checked' })),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  } finally {
    await daemon.close();
  }
});

test('an upstream protocol refusal keeps the upgrade message and names the daemon behind the proxy', async () => {
  const daemon = await remoteDaemon({
    status: 409,
    headers: { [DAEMON_HTTP_REFUSAL_HEADER]: 'upstream-protocol-mismatch' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'test',
      error: {
        code: -32001,
        message: 'skew',
        data: {
          details: { service: 'agent-device-daemon', version: '9.0.0', rpcProtocolVersion: 99 },
        },
      },
    }),
  });
  try {
    const error = await sendToDaemon(sessionList(daemon.baseUrl, { daemonRpc: 'checked' })).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({
      message: expect.stringContaining(
        'the agent-device-daemon behind agent-device-proxy runs 9.0.0 (RPC protocol 99)',
      ),
      details: { upgradeSide: 'client-and-proxy', remoteRpcProtocolVersion: 99, dispatched: 'no' },
    });
    expect(routes(daemon.seen)).toEqual(['POST /rpc/checked']);
  } finally {
    await daemon.close();
  }
});

test('a script-artifacts refusal is not dispatched and removes the publication record', async () => {
  const daemon = await remoteDaemon({
    status: 409,
    headers: { [DAEMON_HTTP_REFUSAL_HEADER]: 'script-artifacts' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'test', error: { code: -32001, message: 'no' } }),
  });
  const root = mkdtempForTestSync('checked-script-');
  const stateDir = path.join(root, 'state');
  try {
    await expect(
      sendToDaemon({
        command: 'open',
        session: 'owned',
        positionals: ['Demo'],
        flags: {
          daemonBaseUrl: daemon.baseUrl,
          daemonRpc: 'checked',
          saveScript: path.join(root, 'journey.ad'),
          stateDir,
        },
      }),
    ).rejects.toMatchObject({
      details: { reason: 'remote_script_artifacts_unsupported', dispatched: 'no' },
    });
    const records = path.join(stateDir, 'remote-connections', 'session-scripts');
    expect(fs.existsSync(records) ? fs.readdirSync(records) : []).toEqual([]);
  } finally {
    await daemon.close();
  }
});

test('a refused connection under checked RPC fails at once as an unavailable remote', async () => {
  const daemon = await remoteDaemon();
  const { baseUrl } = daemon;
  await daemon.close();
  await expect(sendToDaemon(sessionList(baseUrl, { daemonRpc: 'checked' }))).rejects.toMatchObject({
    details: { reason: 'remote_daemon_unavailable', dispatched: 'no', attempts: 1 },
  });
});

test.each([
  { name: 'a daemon without the capability', health: {}, served: false },
  { name: 'a daemon with it', health: { capabilities: ['checked-rpc'] }, served: true },
  {
    name: 'a proxy whose daemon lacks it',
    health: { capabilities: ['checked-rpc'], upstream: { capabilities: [] } },
    served: false,
  },
  {
    name: 'a proxy whose daemon has it',
    health: { capabilities: ['checked-rpc'], upstream: { capabilities: ['checked-rpc'] } },
    served: true,
  },
])(
  'connect accepts daemonRpc checked only when $name advertises checked-rpc',
  async ({ health, served }) => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, ...health }));
    });
    try {
      const verdict = assertRemoteServesCheckedRpc({
        baseUrl: `http://127.0.0.1:${await listenOnLoopback(server)}`,
        token: undefined,
      });
      if (served) await expect(verdict).resolves.toBeUndefined();
      else
        await expect(verdict).rejects.toMatchObject({
          details: { reason: 'remote_checked_rpc_unsupported', dispatched: 'no' },
        });
    } finally {
      await closeLoopbackServer(server);
    }
  },
);
