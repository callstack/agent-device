import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import { getRequestSignal } from '../../../src/request/cancel.ts';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import type { DaemonRequest, DaemonResponse } from '../../../src/daemon/types.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';

const CANCELLATION_ROWS = {
  mutation: { command: 'press', positionals: ['enter'] },
  read: { command: 'snapshot', positionals: [] },
  'artifact-producing': { command: 'screenshot', positionals: ['/tmp/boundary.png'] },
  'session-lifecycle': { command: 'open', positionals: ['Demo'] },
} as const satisfies Record<string, Readonly<{ command: string; positionals: readonly string[] }>>;

for (const [commandClass, row] of Object.entries(CANCELLATION_ROWS)) {
  test(`HTTP cancellation mid-request is scoped for the ${commandClass} command class`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP boundary cancellation coverage')) return;

    const requestId = `boundary-cancellation-${commandClass}`;
    let markHandlerStarted: () => void = () => {};
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    let markAbortObserved: () => void = () => {};
    const abortObserved = new Promise<void>((resolve) => {
      markAbortObserved = resolve;
    });

    const server = await createDaemonHttpServer({
      token: 'boundary-cancellation-token',
      handleRequest: async (request: DaemonRequest): Promise<DaemonResponse> => {
        assert.equal(request.command, row.command);
        const signal = getRequestSignal(requestId);
        assert.ok(signal, 'request signal should be registered before the handler runs');
        markHandlerStarted();
        await waitForAbort(signal);
        assert.equal(signal.aborted, true);
        markAbortObserved();
        return { ok: true, data: { canceled: signal.aborted } };
      },
    });

    try {
      const port = await listenOnLoopback(server);
      const requestClosed = sendRpcAndDisconnectOnceStarted(port, handlerStarted, {
        jsonrpc: '2.0',
        id: `rpc-${requestId}`,
        method: 'agent_device.command',
        params: {
          command: row.command,
          positionals: [...row.positionals],
          meta: { requestId },
        },
      });
      await Promise.all([requestClosed, abortObserved]);
      assert.equal(
        getRequestSignal(requestId),
        undefined,
        'canceled request signal must be cleaned',
      );
    } finally {
      await closeLoopbackServer(server);
    }
  });
}

function sendRpcAndDisconnectOnceStarted(
  port: number,
  handlerStarted: Promise<void>,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/rpc',
      method: 'POST',
      headers: {
        authorization: 'Bearer boundary-cancellation-token',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    });
    request.on('error', () => {
      // The intentional disconnect is reported as a client-side socket error;
      // the server-side AbortSignal is the contract under test.
    });
    void handlerStarted.then(() => {
      request.destroy();
      resolve();
    }, reject);
    request.end(body);
  });
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
