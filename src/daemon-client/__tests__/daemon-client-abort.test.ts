/**
 * #3178: the built-in daemon transports honor a per-call `AbortSignal`.
 *
 * These run the REAL daemon servers (`createSocketServer`, `createDaemonHttpServer`) against a
 * request handler that waits on the daemon's own request-scoped signal, so each mid-flight case
 * proves the whole chain: the client aborts → that one connection closes → the daemon marks the
 * request canceled (`markRequestCanceled`, reached only through the transport's disconnect path) →
 * the client rejects with the typed canceled-request error — and the daemon itself stays alive to
 * serve a follow-up request.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { getRequestSignal, isRequestCanceled } from '@agent-device/host-kit/request';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../daemon/daemon-request.ts';
import { createDaemonHttpServer } from '../../daemon/server/http-server.ts';
import { createSocketServer, listenNetServer } from '../../daemon/server/transport.ts';
import { sendRequest } from '../daemon-client-transport.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  trackLoopbackSockets,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const TOKEN = 'abort-signal-token';
const STATE_PATHS = resolveDaemonPaths(mkdtempForTestSync('agent-device-client-abort-'));

type SeenRequest = {
  started: boolean;
  requestId?: string;
  canceled: boolean[];
  /** The command of the last non-`wait` request the RPC handler itself served. */
  servedCommand?: string;
};

// `wait` models the long request the caller abandons; every other command answers immediately, so
// the same handler also proves the daemon still serves requests after one was canceled.
function canceledAwareHandler(seen: SeenRequest): DaemonInvokeFn {
  return async (req: DaemonRequest): Promise<DaemonResponse> => {
    const requestId = req.meta?.requestId;
    seen.requestId = requestId;
    if (req.command !== 'wait') {
      seen.servedCommand = req.command;
      return { ok: true, data: {} };
    }
    seen.started = true;
    const signal = getRequestSignal(requestId);
    if (!signal) {
      return { ok: true, data: { answeredWithoutSignal: true } };
    }
    // The long request never answers: only the client's disconnect ends it, through the abort.
    return await new Promise<DaemonResponse>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          seen.canceled.push(isRequestCanceled(requestId));
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };
}

function canceledRequestError(error: unknown, dispatched: 'no' | 'unknown'): boolean {
  return (
    isRequestCanceledError(error) &&
    (error as { details?: Record<string, unknown> }).details?.dispatched === dispatched
  );
}

test('socket transport: an already-aborted signal sends nothing and refuses with dispatched no', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const connections: number[] = [];
  const server = createSocketServer(async () => {
    connections.push(1);
    return { ok: true, data: {} };
  });
  try {
    const port = await listenNetServer(server);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      sendRequest(
        { port, token: TOKEN, pid: 1 },
        {
          token: TOKEN,
          command: 'devices',
          session: 'default',
          positionals: [],
          flags: {},
          meta: { requestId: 'req-socket-pre-abort' },
        },
        'socket',
        STATE_PATHS,
        undefined,
        { signal: controller.signal },
      ),
      (error: unknown) => canceledRequestError(error, 'no'),
    );
    assert.deepEqual(connections, []);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('socket transport: an abort mid-request closes the connection, the daemon marks the request canceled, and the daemon stays alive', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const seen: SeenRequest = { started: false, canceled: [] };
  const server = createSocketServer(canceledAwareHandler(seen));
  // The mid-request case's connection only closes through the client's abort; if an assertion
  // above that fails, the daemon-side handler waits forever and `net.Server.close()` would hang
  // the whole lane instead of reporting the failure.
  const destroySockets = trackLoopbackSockets(server);
  try {
    const port = await listenNetServer(server);
    const info = { port, token: TOKEN, pid: 1 };
    const controller = new AbortController();
    const inFlight = sendRequest(
      info,
      {
        token: TOKEN,
        command: 'wait',
        session: 'default',
        positionals: [],
        flags: {},
        meta: { requestId: 'req-socket-abort-in-flight' },
      },
      'socket',
      STATE_PATHS,
      undefined,
      { signal: controller.signal },
    );
    // Abort only once the daemon has the request in hand, so this is genuinely a mid-request
    // cancel rather than a race against connection setup.
    await waitFor(() => seen.started, 'the daemon to start the request');
    controller.abort();
    await assert.rejects(inFlight, (error: unknown) => canceledRequestError(error, 'unknown'));
    // The daemon's disconnect path ran: this request's id is registered-canceled, proven through
    // the daemon-side registry rather than off the client's rejection.
    await waitFor(() => seen.canceled.length > 0, 'daemon-side cancellation');
    assert.deepEqual(seen.canceled, [true]);
    assert.equal(seen.requestId, 'req-socket-abort-in-flight');

    // Daemon alive and serving: a follow-up request without any cancellation completes.
    const followUp = await sendRequest(
      info,
      {
        token: TOKEN,
        command: 'devices',
        session: 'default',
        positionals: [],
        flags: {},
        meta: { requestId: 'req-socket-follow-up' },
      },
      'socket',
      STATE_PATHS,
      5000,
      {},
    );
    assert.equal(followUp.ok, true);
    assert.equal(seen.servedCommand, 'devices');
  } finally {
    destroySockets();
    await closeLoopbackServer(server);
  }
});

test('http transport: an already-aborted signal sends nothing and refuses with dispatched no', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const received: number[] = [];
  const server = await createDaemonHttpServer({
    handleRequest: async () => {
      received.push(1);
      return { ok: true, data: {} };
    },
    token: TOKEN,
  });
  try {
    const port = await listenOnLoopback(server);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      sendRequest(
        { httpPort: port, token: TOKEN, pid: 1 },
        {
          token: TOKEN,
          command: 'devices',
          session: 'default',
          positionals: [],
          flags: {},
          meta: { requestId: 'req-http-pre-abort' },
        },
        'http',
        STATE_PATHS,
        undefined,
        { signal: controller.signal },
      ),
      (error: unknown) => canceledRequestError(error, 'no'),
    );
    assert.deepEqual(received, []);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('http transport: an abort mid-request closes that request, the daemon marks it canceled, and the daemon stays alive', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const seen: SeenRequest = { started: false, canceled: [] };
  const server = await createDaemonHttpServer({
    handleRequest: canceledAwareHandler(seen),
    token: TOKEN,
  });
  try {
    const port = await listenOnLoopback(server);
    const info = { httpPort: port, token: TOKEN, pid: 1 };
    const controller = new AbortController();
    const inFlight = sendRequest(
      info,
      {
        token: TOKEN,
        command: 'wait',
        session: 'default',
        positionals: [],
        flags: {},
        meta: { requestId: 'req-http-abort-in-flight' },
      },
      'http',
      STATE_PATHS,
      undefined,
      { signal: controller.signal },
    );
    await waitFor(() => seen.started, 'the daemon to start the request');
    controller.abort();
    await assert.rejects(inFlight, (error: unknown) => canceledRequestError(error, 'unknown'));
    await waitFor(() => seen.canceled.length > 0, 'daemon-side cancellation');
    assert.deepEqual(seen.canceled, [true]);
    assert.equal(seen.requestId, 'req-http-abort-in-flight');

    const followUp = await sendRequest(
      info,
      {
        token: TOKEN,
        command: 'devices',
        session: 'default',
        positionals: [],
        flags: {},
        meta: { requestId: 'req-http-follow-up' },
      },
      'http',
      STATE_PATHS,
      5000,
      {},
    );
    assert.equal(followUp.ok, true);
    // The follow-up ran through the RPC path `/health` does not: an aborted request's cancel must
    // leave `handleRequest` serving, not just the health endpoint answering.
    assert.equal(seen.servedCommand, 'devices');
  } finally {
    await closeLoopbackServer(server);
  }
});

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
