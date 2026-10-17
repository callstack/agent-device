/**
 * #3178: an abort is never a timeout. `handleRequestTimeout` is the one seam that sweeps runner
 * processes and resets the local daemon, so an abort that settles a request must also disarm that
 * request's timeout timer. The seam is mocked here — the subject is the transport's timer
 * discipline, not the sweep — and each case outlives the armed budget, so the assertion proves the
 * timer was cleared rather than merely beaten to the settle.
 *
 * The socket abort also checks that the exact timer handle armed for the request was cleared. The
 * paired no-signal case lets the same budget expire and must reach the mocked seam, so the test
 * proves both the socket timer setup and the abort cleanup.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { DAEMON_HTTP_INSTANCE_MISMATCH_HEADER } from '@agent-device/contracts/daemon-http';
import { test, vi } from 'vitest';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { sendRequest } from '../daemon-client-transport.ts';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  closeLoopbackServer,
  listenOnLoopback,
  type LoopbackServer,
  mkdtempForTestSync,
  type SkippableTestContext,
  skipWhenLoopbackUnavailable,
  trackLoopbackSockets,
} from '@agent-device/test-kit';

const { handleRequestTimeoutCalls } = vi.hoisted(() => ({
  handleRequestTimeoutCalls: [] as unknown[],
}));

vi.mock('../daemon-client-timeout.ts', () => ({
  handleRequestTimeout: async (params: unknown) => {
    handleRequestTimeoutCalls.push(params);
    return new AppError('COMMAND_FAILED', 'Daemon request timed out', {
      reason: 'daemon_transport_timeout',
    });
  },
}));

const STATE_PATHS = resolveDaemonPaths(mkdtempForTestSync('agent-device-abort-timeout-'));
const TIMEOUT_MS = 15;
// Past the armed budget, so a timer the abort forgot to clear fires inside the case.
const OUTLIVE_MS = 80;

async function runTimerDiscipline(
  t: SkippableTestContext,
  outcome: 'aborted' | 'timed-out',
  transport: 'http' | 'socket' = 'http',
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const aborted = outcome === 'aborted';
  handleRequestTimeoutCalls.length = 0;
  const server: LoopbackServer =
    transport === 'http'
      ? http.createServer(() => {})
      : net.createServer((socket) => socket.on('error', () => {}));
  const destroySockets = trackLoopbackSockets(server);
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
  try {
    const port = await listenOnLoopback(server);
    const controller = new AbortController();
    setTimeoutSpy.mockClear();
    clearTimeoutSpy.mockClear();
    const request = sendRequest(
      transport === 'http' ? { httpPort: port, token: 't', pid: 1 } : { port, token: 't', pid: 1 },
      {
        token: 't',
        command: 'wait',
        session: 'default',
        positionals: [],
        flags: {},
        meta: { requestId: `req-${outcome}-timeout-timer` },
      },
      transport,
      STATE_PATHS,
      TIMEOUT_MS,
      aborted ? { signal: controller.signal } : {},
    );
    if (aborted) {
      const armedTimeoutIndex = setTimeoutSpy.mock.calls.findIndex(
        ([, timeout]) => timeout === TIMEOUT_MS,
      );
      const armedTimeout =
        armedTimeoutIndex === -1 ? undefined : setTimeoutSpy.mock.results[armedTimeoutIndex]?.value;
      if (transport === 'socket') assert.ok(armedTimeout);
      // `sendRequest` armed the timeout timer synchronously by returning; this abort must disarm it.
      controller.abort();
      await assert.rejects(request, (error: unknown) => isRequestCanceledError(error));
      if (transport === 'socket') {
        assert.ok(clearTimeoutSpy.mock.calls.some(([handle]) => handle === armedTimeout));
      }
    } else {
      await assert.rejects(
        request,
        (error: unknown) =>
          error instanceof AppError && error.details?.reason === 'daemon_transport_timeout',
      );
      assert.equal(handleRequestTimeoutCalls.length, 1);
    }
    await new Promise((resolve) => setTimeout(resolve, OUTLIVE_MS));
    if (aborted) assert.deepEqual(handleRequestTimeoutCalls, []);
  } finally {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    destroySockets();
    await closeLoopbackServer(server);
  }
}

test('an abort with a timeout armed clears the timer instead of running the timeout path', async (t) => {
  await runTimerDiscipline(t, 'aborted');
});

test('the same budget without a signal reaches the timeout seam', async (t) => {
  await runTimerDiscipline(t, 'timed-out');
});

test('a socket abort with a timeout armed clears the timer instead of running the timeout path', async (t) => {
  await runTimerDiscipline(t, 'aborted', 'socket');
});

test('the socket budget without a signal reaches the timeout seam', async (t) => {
  await runTimerDiscipline(t, 'timed-out', 'socket');
});

test('an abort during a restart health probe never retires the daemon or redispatches', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  handleRequestTimeoutCalls.length = 0;
  const controller = new AbortController();
  let rpcCount = 0;
  let healthCount = 0;
  let reachedHealth!: () => void;
  const healthStarted = new Promise<void>((resolve) => {
    reachedHealth = resolve;
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      healthCount += 1;
      reachedHealth();
      return;
    }
    rpcCount += 1;
    res.statusCode = 409;
    res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
    res.end();
  });
  const destroySockets = trackLoopbackSockets(server);
  try {
    const port = await listenOnLoopback(server);
    const request = sendRequest(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'secret',
        pid: 1,
        remoteInstanceId: 'previous-instance',
      },
      { token: 'secret', command: 'devices', session: 'default', positionals: [], flags: {} },
      'auto',
      STATE_PATHS,
      1_000,
      { signal: controller.signal },
    );
    const rejection = assert.rejects(request, (error: unknown) => isRequestCanceledError(error));
    await healthStarted;
    controller.abort();
    await rejection;
    assert.equal(rpcCount, 1);
    assert.equal(healthCount, 1);
    assert.deepEqual(handleRequestTimeoutCalls, []);
  } finally {
    controller.abort();
    destroySockets();
    await closeLoopbackServer(server);
  }
});
