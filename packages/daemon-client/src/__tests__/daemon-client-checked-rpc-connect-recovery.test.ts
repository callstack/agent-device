// A checked call whose connection never opens is this client's own proof that nothing left. On fake
// time: the first POST never connects, so the connect timer fires, the `/health` loop runs, and the
// command is sent once more. `http.request` is replaced, so no real socket is involved.

import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, test, vi } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { sendToDaemon } from '../index.ts';

type Call = { method: string; path: string; at: number };

function fakeResponse(): EventEmitter {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    resume: () => {},
    setEncoding: () => {},
  });
}

/**
 * The first checked POST hangs before its socket connects. `/health` answers with `healthStatus`
 * (and an instance ID, so a usable answer is cached); every other request answers.
 */
function firstCheckedConnectHangs(healthStatus = 200, healthProtocol = 3): Call[] {
  const calls: Call[] = [];
  vi.spyOn(http, 'request').mockImplementation(((
    options: { method?: string; path?: string },
    callback: (res: EventEmitter) => void,
  ) => {
    const call = {
      method: options.method ?? 'GET',
      path: options.path ?? '',
      at: performance.now(),
    };
    const checked = call.path.endsWith('/rpc/checked');
    const hangs = checked && !calls.some((seen) => seen.path.endsWith('/rpc/checked'));
    calls.push(call);
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      destroy: () => {},
      end: () => {
        if (hangs) {
          process.nextTick(() =>
            req.emit('socket', Object.assign(new EventEmitter(), { connecting: true })),
          );
          return;
        }
        const body =
          call.method === 'GET'
            ? JSON.stringify({
                ok: true,
                service: 'agent-device-daemon',
                rpcProtocolVersion: healthProtocol,
                instanceId: 'daemon-1',
              })
            : JSON.stringify({
                jsonrpc: '2.0',
                id: 'x',
                result: { ok: true, data: { sent: true } },
              });
        const res = Object.assign(fakeResponse(), {
          statusCode: call.method === 'GET' ? healthStatus : 200,
        });
        process.nextTick(() => {
          callback(res);
          res.emit('data', body);
          res.emit('end');
        });
      },
    });
    return req;
  }) as unknown as typeof http.request);
  return calls;
}

/** Every checked POST is refused before it connects, while `/health` answers 503. */
function checkedConnectRefused(): Call[] {
  const calls: Call[] = [];
  vi.spyOn(http, 'request').mockImplementation(((
    options: { method?: string; path?: string },
    callback: (res: EventEmitter) => void,
  ) => {
    const call = {
      method: options.method ?? 'GET',
      path: options.path ?? '',
      at: performance.now(),
    };
    calls.push(call);
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      destroy: () => {},
      end: () => {
        if (call.method === 'POST') {
          process.nextTick(() =>
            req.emit(
              'error',
              Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
            ),
          );
          return;
        }
        const res = Object.assign(fakeResponse(), { statusCode: 503 });
        process.nextTick(() => {
          callback(res);
          res.emit('data', '');
          res.emit('end');
        });
      },
    });
    return req;
  }) as unknown as typeof http.request);
  return calls;
}

/** Advances fake time to the next timer once real work has gone quiet. Returns the stop. */
function driveFakeTime(): () => Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let driving = true;
  const drive = (async () => {
    while (driving) {
      for (let turn = 0; turn < 20; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    }
  })();
  return async () => {
    driving = false;
    await drive;
  };
}

const BASE_URL = 'http://remote-mac.example.test:7777/agent-device';

let tokenSeq = 0;
/** A token of its own per test: the process health cache is keyed by it. */
function freshToken(): string {
  tokenSeq += 1;
  return `remote-secret-${tokenSeq}`;
}

function sessionList(daemonRpc?: 'checked') {
  return {
    session: 'default',
    command: 'session',
    positionals: ['list'],
    flags: { daemonBaseUrl: BASE_URL, ...(daemonRpc ? { daemonRpc } : {}) },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a checked connect timeout runs the /health loop, then sends exactly once more', async () => {
  const authToken = freshToken();
  const calls = firstCheckedConnectHangs();
  const stopDriving = driveFakeTime();
  try {
    const response = await sendToDaemon(sessionList('checked'), { authToken });

    assert.equal(response.ok, true);
    assert.deepEqual(
      calls.map(({ method, path }) => `${method} ${path}`),
      [
        'POST /agent-device/rpc/checked',
        'GET /agent-device/health',
        'POST /agent-device/rpc/checked',
      ],
    );
    // The connect timer is the `/health` probe's own 3 s limit; the loop then waits its 1 s interval.
    assert.ok((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0) >= 4_000);
  } finally {
    await stopDriving();
  }
});

test('a process holding an instance-pinned /health answer sends the next command fenced on /rpc, with no probe', async () => {
  const calls = firstCheckedConnectHangs();
  const stopDriving = driveFakeTime();
  const authToken = freshToken();
  try {
    // A health-first command in this process pins the daemon instance.
    await sendToDaemon(sessionList(), { authToken });
    calls.length = 0;
    const response = await sendToDaemon(sessionList('checked'), { authToken });

    assert.equal(response.ok, true);
    assert.deepEqual(
      calls.map(({ method, path }) => `${method} ${path}`),
      ['POST /agent-device/rpc'],
    );
  } finally {
    await stopDriving();
  }
});

test('an abort during checked connect recovery rejects with the typed cancellation', async () => {
  firstCheckedConnectHangs(503);
  const stopDriving = driveFakeTime();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 6_000);
  try {
    const outcome = await sendToDaemon(sessionList('checked'), {
      authToken: freshToken(),
      signal: controller.signal,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(isRequestCanceledError(outcome), `unexpected outcome: ${String(outcome)}`);
  } finally {
    await stopDriving();
  }
});

test('a concurrent call that refills the health cache during recovery never stands in for its probe', async () => {
  const authToken = freshToken();
  const calls = firstCheckedConnectHangs();
  const stopDriving = driveFakeTime();
  // Lands after the connect timeout (3 s) and before the recovery probe (4 s).
  const concurrent = new Promise<void>((resolve) => {
    setTimeout(() => {
      void sendToDaemon(sessionList(), { authToken }).then(() => resolve());
    }, 3_500);
  });
  try {
    const response = await sendToDaemon(sessionList('checked'), { authToken });
    await concurrent;

    assert.equal(response.ok, true);
    const routes = calls.map(({ method, path }) => `${method} ${path}`);
    const resend = routes.lastIndexOf('POST /agent-device/rpc/checked');
    const probes = routes.slice(1, resend).filter((route) => route === 'GET /agent-device/health');
    // One probe is the concurrent call's own; the recovery made a live one of its own.
    assert.equal(probes.length, 2, routes.join(', '));
  } finally {
    await stopDriving();
  }
});

test('recovery that finds protocol skew proves nothing left and names no endpoint', async () => {
  firstCheckedConnectHangs(200, 99);
  const stopDriving = driveFakeTime();
  try {
    const outcome = await sendToDaemon(sessionList('checked'), { authToken: freshToken() }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(outcome instanceof Error, `unexpected outcome: ${String(outcome)}`);
    const details = (outcome as { details?: Record<string, unknown> }).details;
    assert.equal(details?.dispatched, 'no');
    assert.equal(details?.daemonBaseUrl, undefined);
    assert.equal(details?.remoteRpcProtocolVersion, 99);
  } finally {
    await stopDriving();
  }
});

test('a refused checked POST fails at once even while /health answers 503', async () => {
  const calls = checkedConnectRefused();
  const stopDriving = driveFakeTime();
  try {
    const started = performance.now();
    const outcome = await sendToDaemon(sessionList('checked'), { authToken: freshToken() }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const details = (outcome as { details?: Record<string, unknown> }).details;
    assert.equal(details?.reason, 'remote_daemon_unavailable');
    assert.equal(details?.dispatched, 'no');
    assert.equal(details?.attempts, 1);
    // No probe loop: one refused POST, no /health retries, no time spent waiting.
    assert.deepEqual(
      calls.map(({ method }) => method),
      ['POST'],
    );
    assert.ok(performance.now() - started < 1_000);
  } finally {
    await stopDriving();
  }
});
