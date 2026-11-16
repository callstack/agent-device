// The remote `/health` gate re-probes a daemon that answers 5xx for the command's own budget. This
// drives a whole default budget on fake time: `http.request` answers on the next tick, so no real
// timer or socket is involved.

import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, test, vi } from 'vitest';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { sendToDaemon } from '../index.ts';

/** Replaces `http.request` with one that answers every request 503, recording each probe's time. */
function answerEveryRequest503(): { probeTimes: number[]; rpcs: () => number } {
  const probeTimes: number[] = [];
  let rpcs = 0;
  vi.spyOn(http, 'request').mockImplementation(((
    options: { method?: string },
    callback: (res: EventEmitter) => void,
  ) => {
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      destroy: () => {},
      end: () => {
        if (options.method === 'GET') probeTimes.push(performance.now());
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
  return { probeTimes, rpcs: () => rpcs };
}

/**
 * Moves fake time only once real work (module loads, the mocked reply) has gone quiet, and then
 * straight to the next timer, so no real latency lands on the faked clock. Returns the stop.
 */
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

/** `session list`, which has the 90s default budget, against a remote daemon. */
function remoteSessionList() {
  return {
    session: 'default',
    command: 'session',
    positionals: ['list'],
    flags: { daemonBaseUrl: 'http://remote-mac.example.test:7777/agent-device' },
    meta: { requestId: 'req-remote-budget' },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a remote daemon answering 5xx for the whole request budget is refused with its probe count and budget', async () => {
  const server = answerEveryRequest503();
  const stopDriving = driveFakeTime();

  try {
    // A non-loopback daemon is trusted only with an auth token.
    const outcome = await sendToDaemon(remoteSessionList(), { authToken: 'remote-secret' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    assert.ok(outcome instanceof AppError, `unexpected outcome: ${String(outcome)}`);
    assert.equal(outcome.code, 'COMMAND_FAILED');
    assert.equal(outcome.details?.reason, 'remote_daemon_unavailable');
    assert.equal(outcome.details?.dispatched, 'no');
    // One probe a second fills the 90s budget.
    assert.equal(outcome.details?.attempts, 90);
    assert.equal(outcome.details?.healthRecoveryBudgetMs, 90_000);
    assert.match(String(outcome.details?.hint ?? ''), /agent-device disconnect/);
    const gaps = server.probeTimes.slice(1).map((at, index) => at - server.probeTimes[index]!);
    assert.deepEqual(gaps, Array<number>(89).fill(1_000), 'probes are one second apart');
    assert.equal(server.rpcs(), 0);
  } finally {
    await stopDriving();
  }
});

test('aborting the request while the gate re-probes stops the probes', async () => {
  const aborting = new AbortController();
  const server = answerEveryRequest503();
  const stopDriving = driveFakeTime();
  try {
    const outcome = sendToDaemon(remoteSessionList(), {
      authToken: 'remote-secret',
      signal: aborting.signal,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Bounded, so a gate that never re-probes fails here instead of hanging the test.
    for (let turn = 0; turn < 10_000 && server.probeTimes.length < 3; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(
      server.probeTimes.length >= 3,
      `the gate re-probed ${server.probeTimes.length} times`,
    );
    aborting.abort();

    assert.ok(isRequestCanceledError(await outcome), 'the abort answers as a cancellation');
    const probesAtAbort = server.probeTimes.length;
    for (let turn = 0; turn < 5; turn += 1) await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(server.probeTimes.length, probesAtAbort, 'no probe follows the abort');
  } finally {
    await stopDriving();
  }
});
