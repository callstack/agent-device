// The remote `/health` gate re-probes a daemon that answers 5xx for the command's own budget. This
// drives a whole default budget on fake time: `http.request` answers on the next tick, so no real
// timer or socket is involved.

import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { sendToDaemon } from '../index.ts';

/** Replaces `http.request` with one that answers every request 503, counting them by method. */
function answerEveryRequest503(): { probes: () => number; rpcs: () => number } {
  let probes = 0;
  let rpcs = 0;
  vi.spyOn(http, 'request').mockImplementation(((
    options: { method?: string },
    callback: (res: EventEmitter) => void,
  ) => {
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      destroy: () => {},
      end: () => {
        if (options.method === 'GET') probes += 1;
        else rpcs += 1;
        const res = Object.assign(new EventEmitter(), {
          statusCode: 503,
          resume: () => {},
          setEncoding: () => {},
        });
        process.nextTick(() => {
          callback(res);
          res.emit('end');
        });
      },
    });
    return req;
  }) as unknown as typeof http.request);
  return { probes: () => probes, rpcs: () => rpcs };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a remote daemon answering 5xx for the whole request budget is refused with its probe count and budget', async () => {
  const server = answerEveryRequest503();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let advancing = true;
  const advance = (async () => {
    while (advancing) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(100);
    }
  })();

  try {
    const outcome = await sendToDaemon(
      {
        session: 'default',
        command: 'session',
        positionals: ['list'],
        flags: { daemonBaseUrl: 'http://remote-mac.example.test:7777/agent-device' },
        meta: { requestId: 'req-remote-budget' },
      },
      // A non-loopback daemon is trusted only with an auth token.
      { authToken: 'remote-secret' },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.ok(outcome instanceof AppError, `unexpected outcome: ${String(outcome)}`);
    assert.equal(outcome.code, 'COMMAND_FAILED');
    assert.equal(outcome.details?.reason, 'remote_daemon_unavailable');
    assert.equal(outcome.details?.dispatched, 'no');
    // At most one probe a second fits the 90s budget, and far more than a fixed resend count. Real
    // module loading can let fake time run ahead, so the exact count is not asserted.
    const attempts = Number(outcome.details?.attempts);
    assert.ok(attempts > 8 && attempts <= 90, `unexpected attempts: ${attempts}`);
    assert.equal(outcome.details?.healthRecoveryBudgetMs, 90_000);
    assert.match(String(outcome.details?.hint ?? ''), /agent-device disconnect/);
    assert.equal(server.probes(), attempts);
    assert.equal(server.rpcs(), 0);
  } finally {
    advancing = false;
    await advance;
  }
});
