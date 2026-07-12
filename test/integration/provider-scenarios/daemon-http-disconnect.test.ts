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

  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => {
      const signal = getRequestSignal(requestId);
      assert.ok(signal, 'request abort signal should be registered before the handler runs');
      markHandlerStarted();
      // No progress is emitted, so no response headers are sent: this exercises
      // the pre-header disconnect path specifically.
      await waitForAbort(signal);
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
    // Resolves only if the handler's request signal fires, proving the pre-header
    // disconnect canceled the request rather than letting it run to completion.
    await Promise.all([handlerStarted, requestClosed]);
  } finally {
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
        res.resume();
        res.on('end', resolve);
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
