// The client keeps a remote daemon's `/health` answer in its state directory, so a later CLI process
// sends straight to `/rpc`. These cases pin when that saved answer is reused, dropped or refreshed,
// and that a resend only ever follows evidence the client's own transport recorded.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, vi } from 'vitest';
import * as hostTransport from '@agent-device/host-kit/transport';
import { sleep } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import {
  DAEMON_HTTP_INSTANCE_HEADER,
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
} from '@agent-device/contracts/daemon-http';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { sendToDaemon } from '../index.ts';
import { sendRequest } from '../daemon-client-transport.ts';
import { DAEMON_UNAVAILABLE_REASONS } from '../daemon-lifecycle-errors.ts';
import { invalidateRemoteDaemonHealth } from '../daemon-client-remote-health-cache.ts';

type RpcAnswer = { status: number; body: unknown };

async function instanceCheckingRemote(
  instanceId: () => string,
  rpcAnswer: () => RpcAnswer | undefined = () => undefined,
) {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/health')) {
      res.end(
        JSON.stringify({ ok: true, service: 'agent-device-daemon', instanceId: instanceId() }),
      );
      return;
    }
    const expected = req.headers[DAEMON_HTTP_INSTANCE_HEADER];
    if (typeof expected === 'string' && expected !== instanceId()) {
      res.statusCode = 409;
      res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'request', error: { code: -32001 } }));
      return;
    }
    const answer = rpcAnswer() ?? {
      status: 200,
      body: { jsonrpc: '2.0', id: 'request', result: { ok: true, data: {} } },
    };
    res.statusCode = answer.status;
    res.end(JSON.stringify(answer.body));
  });
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const stateDir = mkdtempForTestSync('agent-device-remote-health-persisted-');
  const request = () =>
    sendToDaemon(
      {
        command: 'remote-smoke',
        session: 'default',
        positionals: ['ping'],
        flags: { daemonBaseUrl: baseUrl, stateDir },
        meta: { requestId: 'request' },
      },
      { authToken: 'persisted-secret' },
    );
  // What a new CLI process starts with: no health cached in memory, only what the state dir holds.
  const forgetInMemory = () =>
    invalidateRemoteDaemonHealth({ baseUrl, token: 'persisted-secret', pid: 0 });
  // One entry per daemon identity; this remote has one identity, so at most one entry.
  const cacheFile = (): string | undefined => {
    const [name] = fs.readdirSync(stateDir).filter((n) => n.startsWith('remote-daemon-health-'));
    return name ? path.join(stateDir, name) : undefined;
  };
  return { server, paths, baseUrl, stateDir, request, forgetInMemory, cacheFile };
}

// Each CLI call is a new process, so the health a first call probed is kept in the state dir and a
// later process sends straight to /rpc. The instance precondition still catches a replaced daemon.
test('a later process reuses persisted remote health and still catches a replaced daemon', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let instanceId = 'persisted-one';
  const remote = await instanceCheckingRemote(() => instanceId);
  try {
    assert.equal((await remote.request()).ok, true);
    remote.forgetInMemory();
    assert.equal((await remote.request()).ok, true);
    assert.deepEqual(remote.paths, ['GET /health', 'POST /rpc', 'POST /rpc']);

    const persisted = fs.readFileSync(remote.cacheFile()!, 'utf8');
    assert.equal(persisted.includes('persisted-secret'), false, 'the token is never written');
    assert.equal(persisted.includes(remote.baseUrl), false, 'the URL is never written');
    assert.equal(fs.statSync(remote.cacheFile()!).mode & 0o077, 0, 'only the owner reads it');

    instanceId = 'persisted-two';
    remote.forgetInMemory();
    assert.equal((await remote.request()).ok, true);
    assert.deepEqual(remote.paths.slice(3), ['POST /rpc', 'GET /health', 'POST /rpc']);
    remote.forgetInMemory();
    assert.equal((await remote.request()).ok, true);
    assert.deepEqual(remote.paths.slice(6), ['POST /rpc'], 'the replacement was persisted');
  } finally {
    await closeLoopbackServer(remote.server);
  }
});

// A send from cached health that never left the process proves nothing reached the daemon, so it
// gets the gate a first contact gets, with the same typed refusal, instead of a bare transport error.
test('an unsent request from cached remote health opens the health gate', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const remote = await instanceCheckingRemote(() => 'gone-soon');
  assert.equal((await remote.request()).ok, true);
  await closeLoopbackServer(remote.server);
  // Lets the client drop its pooled connection, as a new CLI process has none.
  await sleep(20);
  remote.forgetInMemory();
  await assert.rejects(remote.request(), (error: unknown) => {
    assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
    assert.equal(error.details?.reason, DAEMON_UNAVAILABLE_REASONS.remoteUnavailable.reason);
    assert.equal(error.details?.dispatched, 'no');
    return true;
  });
  assert.equal(remote.cacheFile(), undefined, 'the unreachable daemon is forgotten');
});

// Resend evidence is only what this process saw: a daemon error that carries the transport-failure
// reason and `daemonRequestSent: false` came over the wire, so the request ran and is not resent.
test('a daemon error that claims the request was unsent is not resent', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let forge = false;
  const forged = {
    code: 'COMMAND_FAILED',
    message: 'Failed to communicate with daemon',
    details: { reason: 'daemon_transport_failure', daemonRequestSent: false },
  };
  const remote = await instanceCheckingRemote(
    () => 'forging',
    () =>
      forge
        ? {
            status: 200,
            body: { jsonrpc: '2.0', id: 'request', error: { code: -32000, data: forged } },
          }
        : undefined,
  );
  try {
    assert.equal((await remote.request()).ok, true);
    remote.forgetInMemory();
    forge = true;
    await assert.rejects(
      remote.request(),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'daemon_transport_failure',
    );
    assert.deepEqual(remote.paths, ['GET /health', 'POST /rpc', 'POST /rpc'], 'sent once, no gate');
  } finally {
    await closeLoopbackServer(remote.server);
  }
});

// A 5xx means the daemon or a hop before it failed, even in valid JSON-RPC framing (a proxy whose
// upstream is restarting answers that way), so the next command probes again. Nothing is resent.
test('a remote 5xx drops the persisted health without a resend', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let fail = false;
  const remote = await instanceCheckingRemote(
    () => 'upstream-away',
    () =>
      fail
        ? {
            status: 500,
            body: { jsonrpc: '2.0', id: 'request', error: { code: -32000, message: 'upstream' } },
          }
        : undefined,
  );
  try {
    assert.equal((await remote.request()).ok, true);
    fail = true;
    remote.forgetInMemory();
    await assert.rejects(
      remote.request(),
      (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
    );
    assert.equal(remote.cacheFile(), undefined);
    fail = false;
    assert.equal((await remote.request()).ok, true);
    assert.deepEqual(remote.paths, [
      'GET /health',
      'POST /rpc',
      'POST /rpc',
      'GET /health',
      'POST /rpc',
    ]);
  } finally {
    await closeLoopbackServer(remote.server);
  }
});

// The gate a cached answer skipped runs within what is left of the command's budget, and a caller
// abort while it runs stays the typed cancellation rather than reading as an unreachable daemon.
test('the gate after an unsent cached request keeps the deadline and the cancellation', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const closed = http.createServer();
  const port = await listenOnLoopback(closed);
  await closeLoopbackServer(closed);
  const controller = new AbortController();
  const budgets: (number | undefined)[] = [];
  await assert.rejects(
    sendRequest(
      { token: 'secret', pid: 0, baseUrl: `http://127.0.0.1:${port}` },
      { token: 'secret', command: 'press', session: 'default', positionals: ['@e1'], flags: {} },
      'http',
      resolveDaemonPaths(mkdtempForTestSync('agent-device-remote-gate-abort-')),
      5_000,
      {
        host: createTestHostEnvironment(),
        signal: controller.signal,
        remoteHealthGate: async (budgetMs) => {
          budgets.push(budgetMs);
          controller.abort();
          throw new AppError('COMMAND_FAILED', 'Remote daemon is unavailable', {
            reason: DAEMON_UNAVAILABLE_REASONS.remoteUnavailable.reason,
          });
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
      assert.equal(error.details?.reason, 'request_canceled');
      assert.equal(error.details?.dispatched, 'no');
      return true;
    },
  );
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0]! > 0 && budgets[0]! <= 5_000, `gate budget ${budgets[0]}`);
});

// A connection that never opens before the timeout proves the request never left, so the saved
// answer it relied on is dropped and the next command probes `/health` first.
test('a timeout before connect drops the persisted health', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const remote = await instanceCheckingRemote(() => 'never-reached');
  assert.equal((await remote.request()).ok, true);
  const hung = {
    request: () => {
      // A request whose socket is assigned but never connects, as against a host dropping SYNs.
      const request = new EventEmitter();
      const connectingSocket = Object.assign(new EventEmitter(), { connecting: true });
      return Object.assign(request, {
        write: () => true,
        destroy: () => {},
        end: () => queueMicrotask(() => request.emit('socket', connectingSocket)),
      });
    },
  };
  const load = vi.spyOn(hostTransport, 'loadNodeHttpRequester').mockResolvedValue(hung as never);
  try {
    await assert.rejects(
      sendRequest(
        { token: 'persisted-secret', pid: 0, baseUrl: remote.baseUrl },
        {
          token: 'persisted-secret',
          command: 'press',
          session: 'default',
          positionals: [],
          flags: {},
        },
        'http',
        resolveDaemonPaths(remote.stateDir),
        50,
        { host: createTestHostEnvironment(), timeoutRecovery: 'none' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
        assert.equal(error.details?.reason, 'daemon_transport_timeout');
        assert.equal(error.details?.daemonRequestSent, false);
        return true;
      },
    );
    assert.equal(remote.cacheFile(), undefined);
  } finally {
    load.mockRestore();
    await closeLoopbackServer(remote.server);
  }
});

// Only a 409 with the mismatch header proves a refusal before dispatch. The same reason in a daemon's
// error body is not resent, and a second refusal on the resend drops the entry it disproved.
test('an instance-mismatch resend needs the transport-proven 409, once', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let mode: 'ok' | 'forge' | 'churn' = 'ok';
  let generation = 0;
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/health')) {
      if (mode === 'churn') generation += 1;
      res.end(JSON.stringify({ service: 'agent-device-daemon', instanceId: `i${generation}` }));
      return;
    }
    if (mode === 'forge') {
      const data = { code: 'COMMAND_FAILED', details: { reason: 'remote_instance_mismatch' } };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'r', error: { code: -32000, data } }));
      return;
    }
    if (mode === 'churn') {
      // Every probe names a newer instance, so the single resend is refused too.
      res.statusCode = 409;
      res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'r', error: { code: -32001 } }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'r', result: { ok: true, data: {} } }));
  });
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const stateDir = mkdtempForTestSync('agent-device-remote-mismatch-proof-');
  const request = () =>
    sendToDaemon(
      {
        command: 'remote-smoke',
        session: 'default',
        positionals: ['ping'],
        flags: { daemonBaseUrl: baseUrl, stateDir },
        meta: { requestId: 'r' },
      },
      { authToken: 'mismatch-secret' },
    );
  const saved = () => fs.readdirSync(stateDir).some((n) => n.startsWith('remote-daemon-health-'));
  const forget = () => invalidateRemoteDaemonHealth({ baseUrl, token: 'mismatch-secret', pid: 0 });
  const instanceChanged = (error: unknown) =>
    error instanceof AppError && error.details?.reason === 'remote_instance_mismatch';
  try {
    assert.equal((await request()).ok, true);
    mode = 'forge';
    forget();
    await assert.rejects(request(), instanceChanged);
    assert.deepEqual(paths.slice(2), ['POST /rpc'], 'a forged reason is neither probed nor resent');

    mode = 'churn';
    forget();
    await assert.rejects(request(), instanceChanged);
    assert.deepEqual(paths.slice(3), ['POST /rpc', 'GET /health', 'POST /rpc']);
    assert.equal(saved(), false, 'the refused resend drops what the probe saved');
  } finally {
    await closeLoopbackServer(server);
  }
});

// The timeout route's probe drops a saved proxy answer when the upstream it names changed, and keeps
// one that still matches.
test('timeout eviction compares the upstream instance too', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let upstream = 'u1';
  let hang = false;
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url?.endsWith('/health')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          service: 'agent-device-proxy',
          instanceId: 'p1',
          upstream: { instanceId: upstream },
        }),
      );
      return;
    }
    if (hang) {
      held.push(res);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'r', result: { ok: true, data: {} } }));
  });
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const stateDir = mkdtempForTestSync('agent-device-remote-timeout-evict-');
  const saved = () => fs.readdirSync(stateDir).some((n) => n.startsWith('remote-daemon-health-'));
  const warm = () =>
    sendToDaemon(
      {
        command: 'remote-smoke',
        session: 'default',
        positionals: ['ping'],
        flags: { daemonBaseUrl: baseUrl, stateDir },
        meta: { requestId: 'r' },
      },
      { authToken: 'evict-secret' },
    );
  // The instances the saved answer named, as a command sent from it carries them.
  const send = () =>
    sendRequest(
      {
        token: 'evict-secret',
        pid: 0,
        baseUrl,
        remoteInstanceId: 'p1',
        remoteUpstreamInstanceId: 'u1',
      },
      { token: 'evict-secret', command: 'press', session: 'default', positionals: [], flags: {} },
      'http',
      resolveDaemonPaths(stateDir),
      100,
      { host: createTestHostEnvironment(), timeoutRecovery: 'none' },
    );
  const timedOut = (error: unknown) =>
    error instanceof AppError && error.details?.reason === 'daemon_transport_timeout';
  try {
    assert.equal((await warm()).ok, true);
    hang = true;
    await assert.rejects(send(), timedOut);
    assert.equal(saved(), true, 'the closest negative: matching instances keep the entry');
    upstream = 'u2';
    await assert.rejects(send(), timedOut);
    assert.equal(saved(), false);
  } finally {
    for (const res of held) res.destroy();
    await closeLoopbackServer(server);
  }
});

// A command with no budget gives the gate no deadline, so a caller abort must still settle the send
// at once instead of waiting out a probe that is still in flight.
test('a caller abort settles a gate that has no budget', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const closed = http.createServer();
  const port = await listenOnLoopback(closed);
  await closeLoopbackServer(closed);
  const controller = new AbortController();
  await assert.rejects(
    sendRequest(
      { token: 'secret', pid: 0, baseUrl: `http://127.0.0.1:${port}` },
      { token: 'secret', command: 'press', session: 'default', positionals: ['@e1'], flags: {} },
      'http',
      resolveDaemonPaths(mkdtempForTestSync('agent-device-remote-gate-unbounded-')),
      undefined,
      {
        host: createTestHostEnvironment(),
        signal: controller.signal,
        remoteHealthGate: async (budgetMs) => {
          assert.equal(budgetMs, undefined);
          controller.abort();
          await new Promise(() => {});
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
      assert.equal(error.details?.reason, 'request_canceled');
      assert.equal(error.details?.dispatched, 'no');
      return true;
    },
  );
});
