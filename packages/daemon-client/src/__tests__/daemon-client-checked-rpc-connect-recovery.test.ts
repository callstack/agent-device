// A checked call whose connection never opens is this client's own proof that nothing left. On fake
// time: the first POST never connects, so the connect timer fires, the `/health` loop runs, and the
// command is sent once more. `http.request` is replaced, so no real socket is involved.

import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, test, vi } from 'vitest';
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

/** The first checked POST hangs before its socket connects; everything after it answers. */
function firstConnectHangs(): Call[] {
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
    const hangs =
      calls.filter((seen) => seen.method === 'POST').length === 1 && call.method === 'POST';
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
            ? JSON.stringify({ ok: true, service: 'agent-device-daemon', rpcProtocolVersion: 3 })
            : JSON.stringify({
                jsonrpc: '2.0',
                id: 'x',
                result: { ok: true, data: { sent: true } },
              });
        const res = fakeResponse();
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a checked connect timeout runs the /health loop, then sends exactly once more', async () => {
  const calls = firstConnectHangs();
  const stopDriving = driveFakeTime();
  try {
    const response = await sendToDaemon(
      {
        session: 'default',
        command: 'session',
        positionals: ['list'],
        flags: {
          daemonBaseUrl: 'http://remote-mac.example.test:7777/agent-device',
          daemonRpc: 'checked',
        },
      },
      { authToken: 'remote-secret' },
    );

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
