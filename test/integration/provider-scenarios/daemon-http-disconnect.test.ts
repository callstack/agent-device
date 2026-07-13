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

// A non-streaming request that loses its client before response headers must be
// marked canceled through its request-scoped AbortSignal. The old behavior only
// reacted after headers were sent, so a pre-header disconnect kept running.
test('HTTP request disconnected before response headers cancels the request', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP disconnect coverage')) return;

  const requestId = 'req-http-pre-header-disconnect';
  let markHandlerStarted: () => void = () => {};
  const handlerStarted = new Promise<void>((resolve) => {
    markHandlerStarted = resolve;
  });
  let markAbortObserved: () => void = () => {};
  const abortObserved = new Promise<void>((resolve) => {
    markAbortObserved = resolve;
  });

  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => {
      const signal = getRequestSignal(requestId);
      assert.ok(signal, 'request abort signal should be registered before the handler runs');
      markHandlerStarted();
      // No progress is emitted, so no response headers are sent: this exercises
      // the pre-header disconnect path specifically.
      await waitForAbort(signal);
      markAbortObserved();
      return { ok: true, data: { canceled: signal.aborted } };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const requestClosed = sendRpcAndDisconnectOnceStarted(port, handlerStarted, {
      jsonrpc: '2.0',
      id: 'rpc-http-pre-header-disconnect',
      method: 'agent_device.command',
      params: {
        command: 'snapshot',
        flags: { platform: 'ios' },
        meta: { requestId },
      },
    });
    await Promise.all([requestClosed, abortObserved]);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('concurrent HTTP requests reject a duplicate request ID without replacing its signal', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP disconnect coverage')) return;

  const requestId = 'req-http-duplicate';
  let markFirstStarted: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseFirst: () => void = () => {};
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstSignal: AbortSignal | undefined;

  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => {
      firstSignal = getRequestSignal(requestId);
      assert.ok(firstSignal);
      markFirstStarted();
      await firstReleased;
      return { ok: true, data: { survived: !firstSignal.aborted } };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const payload = {
      jsonrpc: '2.0',
      id: 'rpc-http-duplicate',
      method: 'agent_device.command',
      params: {
        command: 'devices',
        meta: { requestId },
      },
    };
    const first = postRpcResponse(port, payload);
    await firstStarted;

    const duplicate = await postRpcResponse(port, payload);
    assert.equal(duplicate.error?.data?.code, 'INVALID_ARGS');
    assert.equal(duplicate.error?.data?.details?.reason, 'duplicate_request_id');
    assert.equal(getRequestSignal(requestId), firstSignal);
    assert.equal(firstSignal?.aborted, false);

    releaseFirst();
    const firstResponse = await first;
    assert.equal(firstResponse.result?.ok, true);
    assert.deepEqual(firstResponse.result?.data, { survived: true });
  } finally {
    releaseFirst();
    await closeLoopbackServer(server);
  }
});

// Disconnecting one request must not cancel another concurrent request. This is
// the isolation the removed global Apple-runner abort violated.
test('disconnecting one HTTP request leaves another request uncanceled', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP disconnect coverage')) return;

  const disconnectedRequestId = 'req-http-disconnected';
  const survivorRequestId = 'req-http-survivor';
  let markDisconnectedStarted: () => void = () => {};
  const disconnectedStarted = new Promise<void>((resolve) => {
    markDisconnectedStarted = resolve;
  });
  let markSurvivorStarted: () => void = () => {};
  const survivorStarted = new Promise<void>((resolve) => {
    markSurvivorStarted = resolve;
  });
  let releaseSurvivor: () => void = () => {};
  const survivorReleased = new Promise<void>((resolve) => {
    releaseSurvivor = resolve;
  });
  let survivorSignalAbortedDuringPeerTeardown = false;

  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.meta?.requestId === disconnectedRequestId) {
        const signal = getRequestSignal(disconnectedRequestId);
        assert.ok(signal);
        markDisconnectedStarted();
        await waitForAbort(signal);
        // The survivor is still in-flight here; its signal must not have fired.
        survivorSignalAbortedDuringPeerTeardown =
          getRequestSignal(survivorRequestId)?.aborted ?? false;
        releaseSurvivor();
        return { ok: true, data: {} };
      }
      markSurvivorStarted();
      await survivorReleased;
      return { ok: true, data: { survived: true } };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    // Keep the survivor in-flight first, then disconnect the peer.
    const survivor = postRpc(port, {
      jsonrpc: '2.0',
      id: 'rpc-http-survivor',
      method: 'agent_device.command',
      params: {
        command: 'devices',
        meta: { requestId: survivorRequestId },
      },
    });
    await survivorStarted;
    const disconnected = sendRpcAndDisconnectOnceStarted(port, disconnectedStarted, {
      jsonrpc: '2.0',
      id: 'rpc-http-disconnected',
      method: 'agent_device.command',
      params: {
        command: 'snapshot',
        flags: { platform: 'ios' },
        meta: { requestId: disconnectedRequestId },
      },
    });

    await Promise.all([disconnected, survivor]);
    assert.equal(
      survivorSignalAbortedDuringPeerTeardown,
      false,
      'a peer disconnect must not abort another request',
    );
  } finally {
    await closeLoopbackServer(server);
  }
});

function sendRpcAndDisconnectOnceStarted(
  port: number,
  handlerStarted: Promise<void>,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/rpc',
      method: 'POST',
      headers: {
        authorization: 'Bearer provider-scenario-token',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    });
    req.on('error', () => {
      // The forced disconnect surfaces as a socket error on the client; the
      // server-side cancellation is what this test asserts.
    });
    // Once the daemon handler has started, drop the connection before it can
    // write a response, then let the server observe the disconnect.
    void handlerStarted.then(() => {
      req.destroy();
      resolve();
    });
    req.on('close', resolve);
    req.end(body);
    // Guard against the handler never starting.
    handlerStarted.catch(reject);
  });
}

function postRpc(port: number, payload: Record<string, unknown>): Promise<void> {
  return postRpcResponse(port, payload).then(() => undefined);
}

type JsonRpcTestResponse = {
  result?: DaemonResponse;
  error?: {
    data?: {
      code?: string;
      details?: {
        reason?: string;
      };
    };
  };
};

function postRpcResponse(
  port: number,
  payload: Record<string, unknown>,
): Promise<JsonRpcTestResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          authorization: 'Bearer provider-scenario-token',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          resolve(JSON.parse(responseBody) as JsonRpcTestResponse);
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
