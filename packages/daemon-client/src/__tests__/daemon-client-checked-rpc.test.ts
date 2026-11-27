import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import {
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import { assertRemoteServesCheckedRpc, sendToDaemon } from '../index.ts';
import { checkedRpcTargetFingerprint } from '../daemon-client-lifecycle.ts';

type Seen = {
  method: string;
  url: string;
  protocol: string | undefined;
  instance: string | undefined;
};
type Answer = { status?: number; headers?: Record<string, string>; body: string };

const OK_ANSWER: Answer = {
  body: JSON.stringify({ jsonrpc: '2.0', id: 'test', result: { ok: true, data: {} } }),
};

/** A remote daemon that records every request and answers RPCs with `answer`. */
async function remoteDaemon(answer: Answer = OK_ANSWER, pinned = false) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const protocol = req.headers[DAEMON_HTTP_RPC_PROTOCOL_HEADER];
    const instance = req.headers['x-agent-device-instance'];
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      protocol: typeof protocol === 'string' ? protocol : undefined,
      instance: typeof instance === 'string' ? instance : undefined,
    });
    req.resume();
    req.on('end', () => {
      if (req.url?.endsWith('/health')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            service: 'agent-device-daemon',
            rpcProtocolVersion: 3,
            ...(pinned ? { instanceId: 'daemon-1' } : {}),
          }),
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

test('an upstream protocol refusal keeps the upgrade message, the typed reason and the refusing side', async () => {
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
      details: {
        reason: 'remote_rpc_protocol_mismatch',
        service: 'agent-device-daemon',
        version: '9.0.0',
        rpcProtocolVersion: 99,
        upgradeSide: 'client-and-proxy',
        dispatched: 'no',
      },
    });
    expect(routes(daemon.seen)).toEqual(['POST /rpc/checked']);
  } finally {
    await daemon.close();
  }
});

test('a refusal value this build does not know is an unreadable reply, never a protocol mismatch', async () => {
  const daemon = await remoteDaemon({
    status: 409,
    headers: { [DAEMON_HTTP_REFUSAL_HEADER]: 'future-precondition' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'test', error: { code: -32001, message: 'no' } }),
  });
  try {
    const error = await sendToDaemon(sessionList(daemon.baseUrl, { daemonRpc: 'checked' })).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ details: { reason: 'daemon_response_invalid' } });
    expect(error).not.toMatchObject({ details: { dispatched: 'no' } });
    expect(routes(daemon.seen)).toEqual(['POST /rpc/checked']);
  } finally {
    await daemon.close();
  }
});

test('a checked open proven undispatched removes its publication record', async () => {
  const daemon = await remoteDaemon();
  const { baseUrl } = daemon;
  await daemon.close();
  const root = mkdtempForTestSync('checked-script-');
  const stateDir = path.join(root, 'state');
  await expect(
    sendToDaemon({
      command: 'open',
      session: 'owned',
      positionals: ['Demo'],
      flags: {
        daemonBaseUrl: baseUrl,
        daemonRpc: 'checked',
        saveScript: path.join(root, 'journey.ad'),
        stateDir,
      },
    }),
  ).rejects.toMatchObject({ details: { reason: 'remote_daemon_unavailable', dispatched: 'no' } });
  const records = path.join(stateDir, 'remote-connections', 'session-scripts');
  expect(fs.existsSync(records) ? fs.readdirSync(records) : []).toEqual([]);
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
    health: {
      service: 'agent-device-proxy',
      capabilities: ['checked-rpc'],
      upstream: { capabilities: [] },
    },
    served: false,
  },
  {
    name: 'a proxy that reports no daemon behind it',
    health: { service: 'agent-device-proxy', capabilities: ['checked-rpc'], upstream: null },
    served: false,
  },
  {
    name: 'a proxy whose daemon has it',
    health: {
      service: 'agent-device-proxy',
      capabilities: ['checked-rpc'],
      upstream: { service: 'agent-device-daemon', capabilities: ['checked-rpc'] },
    },
    served: true,
  },
  {
    name: 'a proxy whose upstream is another proxy',
    health: {
      service: 'agent-device-proxy',
      capabilities: ['checked-rpc'],
      upstream: { service: 'agent-device-proxy', capabilities: ['checked-rpc'] },
    },
    served: false,
  },
])(
  'assertRemoteServesCheckedRpc accepts only when $name proves checked-rpc on every link',
  async ({ health, served }) => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, ...health }));
    });
    try {
      const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
      const verdict = assertRemoteServesCheckedRpc(
        { daemonBaseUrl: baseUrl },
        createTestHostEnvironment(),
      );
      // A served remote resolves to the fingerprint of the exact checked target `connect` records.
      if (served) await expect(verdict).resolves.toBe(checkedRpcTargetFingerprint(baseUrl));
      else
        await expect(verdict).rejects.toMatchObject({
          details: { reason: 'remote_checked_rpc_unsupported', dispatched: 'no' },
        });
    } finally {
      await closeLoopbackServer(server);
    }
  },
);

test('the connect probe is refused by remote trust validation before any request leaves', async () => {
  const requests = vi.spyOn(http, 'request');
  try {
    await expect(
      assertRemoteServesCheckedRpc(
        { daemonBaseUrl: 'http://remote-mac.example.test:7777/agent-device' },
        createTestHostEnvironment(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(
      assertRemoteServesCheckedRpc(
        { daemonBaseUrl: 'ftp://remote-mac.example.test/agent-device', daemonAuthToken: 'secret' },
        createTestHostEnvironment(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(requests).not.toHaveBeenCalled();
  } finally {
    requests.mockRestore();
  }
});

test('checked RPC goes only to the exact target connect fingerprinted', async () => {
  const daemon = await remoteDaemon();
  try {
    const approved = `${daemon.baseUrl}/agent-device`;
    const target = checkedRpcTargetFingerprint(approved);
    const send = async (daemonBaseUrl: string) => {
      daemon.seen.length = 0;
      await sendToDaemon(
        sessionList(daemonBaseUrl, { daemonRpc: 'checked', daemonRpcTarget: target }),
      );
      return routes(daemon.seen);
    };

    expect(await send(approved)).toEqual(['POST /agent-device/rpc/checked']);
    // The same prefix with a query `token`: the route resolves at the origin root, a target
    // connect never probed, so the command goes health-first.
    expect(await send(`${approved}?token=x`)).toEqual(['GET /health', 'POST /rpc']);
    expect(await send(daemon.baseUrl)).toEqual(['GET /health', 'POST /rpc']);
  } finally {
    await daemon.close();
  }
});

test('a lease heartbeat goes health-first under checked RPC, and the next command reuses its fenced answer', async () => {
  const daemon = await remoteDaemon(OK_ANSWER, true);
  try {
    await sendToDaemon({
      session: 'default',
      command: 'lease_heartbeat',
      positionals: [],
      flags: { daemonBaseUrl: daemon.baseUrl, daemonRpc: 'checked', leaseId: 'lease-1' },
    });
    await sendToDaemon(sessionList(daemon.baseUrl, { daemonRpc: 'checked' }));

    expect(routes(daemon.seen)).toEqual(['GET /health', 'POST /rpc', 'POST /rpc']);
    expect(daemon.seen[2]?.instance).toBe('daemon-1');
  } finally {
    await daemon.close();
  }
});

test('no checked failure names the endpoint, and an unknown refusal value never reaches the error', async () => {
  const errors: unknown[] = [];
  const capture = async (run: () => Promise<unknown>) => {
    errors.push(await run().catch((error: unknown) => error));
  };
  for (const answer of [
    { status: 404, body: 'Not found' },
    {
      status: 409,
      headers: { [DAEMON_HTTP_REFUSAL_HEADER]: 'protocol-missing' },
      body: '{}',
    },
    {
      status: 409,
      headers: { [DAEMON_HTTP_REFUSAL_HEADER]: 'http://10.0.0.1/secret-refusal' },
      body: '{}',
    },
    {
      status: 409,
      headers: { [DAEMON_HTTP_REFUSAL_HEADER]: 'protocol-mismatch' },
      body: JSON.stringify({
        error: {
          data: {
            details: { service: 'agent-device-daemon', version: '9.0.0', rpcProtocolVersion: 99 },
          },
        },
      }),
    },
  ]) {
    const daemon = await remoteDaemon(answer);
    try {
      await capture(() => sendToDaemon(sessionList(daemon.baseUrl, { daemonRpc: 'checked' })));
    } finally {
      await daemon.close();
    }
  }
  await capture(() =>
    assertRemoteServesCheckedRpc(
      { daemonBaseUrl: 'http://127.0.0.1:9/' },
      createTestHostEnvironment(),
    ),
  );
  await capture(() =>
    assertRemoteServesCheckedRpc(
      { daemonBaseUrl: 'ftp://user:pw@127.0.0.1/x' },
      createTestHostEnvironment(),
    ),
  );
  await capture(() => assertRemoteServesCheckedRpc({}, createTestHostEnvironment()));

  expect(errors).toHaveLength(7);
  for (const error of errors) {
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify((error as { details?: unknown }).details)).not.toMatch(
      /127\.0\.0\.1|10\.0\.0\.1/,
    );
  }
  expect(errors[2]).toMatchObject({ details: { refusal: 'unknown' } });
  expect(errors[6]).toMatchObject({
    details: { reason: 'remote_checked_rpc_unsupported', dispatched: 'no' },
  });
});
