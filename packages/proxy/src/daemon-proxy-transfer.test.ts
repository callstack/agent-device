import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, onTestFinished, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  createDaemonProxy,
  createDaemonProxyServer,
  type DaemonProxyOptions,
} from './daemon-proxy.ts';

const options = {
  upstreamBaseUrl: 'http://daemon.internal:4310',
  upstreamToken: 'daemon-secret',
  clientToken: 'client-secret',
};

const rpcBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'agent-device.command',
  params: { token: 'client-secret', command: 'version' },
});

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function requestThroughProxy(origin: string, path: string, method = 'POST') {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request(
      `${origin}${path}`,
      {
        method,
        headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

test('the actual proxy HTTP response exposes a header timeout as 500 with exactly three transfer details', async () => {
  let entered!: () => void;
  const uploaded = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const daemon = await listen(
    http.createServer((req) => {
      req.resume();
      req.once('end', entered);
    }),
  );
  const origin = await listen(createDaemonProxyServer({ ...options, upstreamBaseUrl: daemon }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const original = http.request;
  let flushed!: (request: http.ClientRequest) => void;
  const finished = new Promise<http.ClientRequest>((resolve) => {
    flushed = resolve;
  });
  const observer = vi.spyOn(http, 'request').mockImplementation((...args) => {
    const req = Reflect.apply(original, http, args) as http.ClientRequest;
    if (req.getHeader('authorization') === 'Bearer daemon-secret') {
      req.once('finish', () => flushed(req));
    }
    return req;
  });
  onTestFinished(() => observer.mockRestore());
  const response = requestThroughProxy(origin, '/upload/preflight');
  await uploaded;
  expect((await finished).writableFinished).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await response).toEqual({
    status: 500,
    body: {
      ok: false,
      error: 'Artifact transfer response-headers timed out',
      code: 'COMMAND_FAILED',
      reason: 'transfer_phase_timeout',
      transferPhase: 'response-headers',
      timeoutMs: 30_000,
    },
  });
});

test('the actual HTTP response exposes the forwarding aggregate when a custom transport ignores cancellation', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const origin = await listen(
    createDaemonProxyServer({
      ...options,
      upstreamFetch: () => {
        entered();
        return new Promise<Response>(() => undefined);
      },
    }),
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const response = requestThroughProxy(origin, '/upload/preflight');
  await started;
  await vi.advanceTimersByTimeAsync(600_000);
  expect(await response).toEqual({
    status: 500,
    body: {
      ok: false,
      error: 'Proxy transfer forwarding deadline exceeded',
      code: 'COMMAND_FAILED',
      reason: 'transfer_forwarding_deadline_exceeded',
      transferPhase: 'forwarding',
      timeoutMs: 600_000,
    },
  });
});

test.each([
  {
    code: 'INVALID_ARGS',
    status: 400,
    phase: 'response-body',
    budget: 120_000,
    reason: 'transfer_phase_timeout',
  },
  {
    code: 'COMMAND_FAILED',
    status: 500,
    phase: 'unknown-phase',
    budget: 120_000,
    reason: 'transfer_phase_timeout',
  },
  {
    code: 'COMMAND_FAILED',
    status: 500,
    phase: 'response-headers',
    budget: 120_000,
    reason: 'transfer_phase_timeout',
  },
  {
    code: 'COMMAND_FAILED',
    status: 500,
    phase: 'forwarding',
    budget: 600_001,
    reason: 'transfer_forwarding_deadline_exceeded',
  },
  {
    code: 'COMMAND_FAILED',
    status: 500,
    phase: 'response-body',
    budget: 600_000,
    reason: 'transfer_forwarding_deadline_exceeded',
  },
] as const)(
  'actual HTTP $status omits invalid transfer detail combinations ($code/$phase/$budget)',
  async ({ code, status, phase, budget, reason }) => {
    const origin = await listen(
      createDaemonProxyServer({
        ...options,
        upstreamFetch: async () => {
          throw new AppError(code, 'Invalid transfer metadata', {
            reason,
            transferPhase: phase,
            timeoutMs: budget,
            secret: 'hidden',
          });
        },
      }),
    );
    expect(await requestThroughProxy(origin, '/upload/preflight')).toEqual({
      status,
      body: { ok: false, error: 'Invalid transfer metadata', code },
    });
  },
);

test('recognized forwarding details are additive on transfers and absent on diagnostics and health', async () => {
  const proxy = createDaemonProxy({
    ...options,
    upstreamFetch: async () => {
      throw new AppError('COMMAND_FAILED', 'Proxy transfer forwarding deadline exceeded', {
        reason: 'transfer_forwarding_deadline_exceeded',
        transferPhase: 'forwarding',
        timeoutMs: 600_000,
        secret: 'hidden',
      });
    },
  });
  const send = (path: string) =>
    proxy.handle(
      new Request(`http://gateway.test${path}`, {
        headers: { authorization: 'Bearer client-secret' },
      }),
    );
  expect(await (await send('/artifacts/build')).json()).toEqual({
    ok: false,
    error: 'Proxy transfer forwarding deadline exceeded',
    code: 'COMMAND_FAILED',
    reason: 'transfer_forwarding_deadline_exceeded',
    transferPhase: 'forwarding',
    timeoutMs: 600_000,
  });
  for (const path of ['/health', '/sessions/session/requests/request/diagnostics']) {
    expect(await (await send(path)).json()).toEqual({
      ok: false,
      error: 'Proxy transfer forwarding deadline exceeded',
      code: 'COMMAND_FAILED',
    });
  }
});

test('a custom transport receives every route family including transfers', async () => {
  const seen: Request[] = [];
  const custom: DaemonProxyOptions['upstreamFetch'] = async (request) => {
    seen.push(request);
    const path = new URL(request.url).pathname;
    if (path === '/upload/preflight')
      return Response.json({
        uploadId: 'ticket',
        upload: { url: 'http://daemon.internal:4310/upload/direct/ticket' },
      });
    if (path === '/rpc') return Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    return new Response('custom answer');
  };
  const proxy = createDaemonProxy({ ...options, upstreamFetch: custom });
  for (const [method, path] of [
    ['POST', '/upload'],
    ['POST', '/upload/preflight'],
    ['POST', '/upload/finalize'],
    ['PUT', '/upload/direct/ticket'],
    ['GET', '/artifacts/build'],
    ['GET', '/sessions/session/requests/request/diagnostics'],
    ['GET', '/health'],
    ['POST', '/rpc'],
  ]) {
    const response = await proxy.handle(
      new Request(`http://gateway.test${path}`, {
        method,
        headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
        ...(method === 'POST' || method === 'PUT'
          ? {
              body: path === '/rpc' ? rpcBody : '{}',
            }
          : {}),
      }),
    );
    expect(response.status, path).toBe(200);
    await response.text();
  }
  expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
    '/upload',
    '/upload/preflight',
    '/upload/finalize',
    '/upload/direct/ticket',
    '/artifacts/build',
    '/sessions/session/requests/request/diagnostics',
    '/health',
    '/rpc',
  ]);
  expect(
    seen.every((request) => request.headers.get('authorization') === 'Bearer daemon-secret'),
  ).toBe(true);
});

test('admitted transfers use Node while RPC and diagnostics use Fetch', async () => {
  const daemon = await listen(
    http.createServer((req, res) => {
      req.resume();
      res.setHeader('content-type', 'application/json');
      res.end(
        req.url === '/upload/preflight'
          ? JSON.stringify({
              uploadId: 'ticket',
              upload: { url: `http://${req.headers.host}/upload/direct/ticket` },
            })
          : '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      );
    }),
  );
  const node = vi.spyOn(http, 'request');
  const fetch = vi.spyOn(globalThis, 'fetch');
  onTestFinished(() => {
    node.mockRestore();
    fetch.mockRestore();
  });
  const proxy = createDaemonProxy({ ...options, upstreamBaseUrl: daemon });
  for (const [method, path, transfer] of [
    ['POST', '/upload', true],
    ['POST', '/upload/preflight', true],
    ['POST', '/upload/finalize', true],
    ['PUT', '/upload/direct/ticket', true],
    ['GET', '/artifacts', true],
    ['GET', '/artifacts/', true],
    ['GET', '/artifacts/build', true],
    ['POST', '/rpc', false],
    ['GET', '/sessions/s/requests/r/diagnostics', false],
  ] as const) {
    node.mockClear();
    fetch.mockClear();
    const response = await proxy.handle(
      new Request(`http://gateway.test${path}`, {
        method,
        headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
        ...(method === 'POST' || method === 'PUT'
          ? { body: path === '/rpc' ? rpcBody : '{}' }
          : {}),
      }),
    );
    expect(response.status, path).toBe(200);
    await response.text();
    expect(node.mock.calls.length, path).toBe(transfer ? 1 : 0);
    expect(fetch.mock.calls.length, path).toBe(transfer ? 0 : 1);
  }
  for (const [method, path] of [
    ['GET', '/upload'],
    ['POST', '/upload/direct/x'],
    ['POST', '/artifacts/x'],
    ['PUT', '/upload/direct'],
  ] as const) {
    expect((await proxy.handle(new Request(`http://gateway.test${path}`, { method }))).status).toBe(
      404,
    );
  }
});

test.each([false, true])(
  'non-transfer routes never load transfer mechanics (failure=%s)',
  async (failure) => {
    vi.resetModules();
    vi.doMock('./transfer-transport.ts', () => {
      throw new Error('transfer mechanics loaded');
    });
    onTestFinished(() => {
      vi.doUnmock('./transfer-transport.ts');
      vi.resetModules();
    });
    const { createDaemonProxy: create } = await import('./daemon-proxy.ts');
    const proxy = create({
      ...options,
      upstreamFetch: async () => {
        if (failure) throw new AppError('COMMAND_FAILED', 'original non-transfer failure');
        return Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
      },
    });
    for (const path of ['/rpc', '/health', '/sessions/s/requests/r/diagnostics']) {
      const response = await proxy.handle(
        new Request(`http://gateway.test${path}`, {
          method: path === '/rpc' ? 'POST' : 'GET',
          headers: { authorization: 'Bearer client-secret' },
          ...(path === '/rpc' ? { body: rpcBody } : {}),
        }),
      );
      expect(response.status, path).toBe(failure ? 500 : 200);
      const body = await response.json();
      if (failure) expect(JSON.stringify(body)).toContain('original non-transfer failure');
      expect(body).not.toHaveProperty('transferPhase');
      expect(body).not.toHaveProperty('timeoutMs');
    }
  },
);

test('an explicit operator cap settles an ignored custom request and reaches its bounded signal', async () => {
  let bounded!: Request;
  const origin = await listen(
    createDaemonProxyServer({
      ...options,
      upstreamTimeoutMs: 10,
      upstreamFetch: (request) => {
        bounded = request;
        return new Promise<Response>(() => undefined);
      },
    }),
  );
  const response = await requestThroughProxy(origin, '/upload/preflight');
  expect(response.status).toBe(500);
  assert.ok(bounded.signal.aborted);
  expect(bounded.signal.reason.name).toBe('TimeoutError');
  expect(response.body).not.toHaveProperty('transferPhase');
  expect(response.body).not.toHaveProperty('timeoutMs');
});

test.each([401, 413, 200])(
  'an early %s crosses the real proxy HTTP listener while ingress remains unfinished',
  async (status) => {
    const daemon = await listen(
      http.createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{"answer":"intact"}');
      }),
    );
    const origin = await listen(createDaemonProxyServer({ ...options, upstreamBaseUrl: daemon }));
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        `${origin}/upload/direct/ticket`,
        {
          method: 'PUT',
          headers: {
            authorization: 'Bearer client-secret',
            'content-type': 'application/octet-stream',
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.once('error', reject);
          res.once('end', () => {
            expect(req.writableEnded).toBe(false);
            resolve({ status: res.statusCode!, text });
            req.destroy();
          });
        },
      );
      req.on('error', reject);
      req.write(Buffer.from('unfinished ingress'));
      onTestFinished(() => {
        req.destroy();
      });
    });
    expect(response).toEqual({ status, text: '{"answer":"intact"}' });
  },
);

test.each([205, 304, 400, 500, 599])(
  'a final upstream %s crosses the real HTTP proxy without normalization',
  async (status) => {
    const noBody = status === 205 || status === 304;
    const daemon = await listen(
      http.createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(noBody ? undefined : '{"answer":"upstream"}');
      }),
    );
    const origin = await listen(createDaemonProxyServer({ ...options, upstreamBaseUrl: daemon }));
    expect(await requestThroughProxy(origin, '/artifacts/build', 'GET')).toEqual({
      status,
      body: noBody ? {} : { answer: 'upstream' },
    });
  },
);
