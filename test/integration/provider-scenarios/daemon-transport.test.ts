import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '../../../src/daemon/types.ts';
import {
  createSocketServer,
  listenHttpServer,
  listenNetServer,
} from '../../../src/daemon/server/transport.ts';
import { getRequestSignal } from '../../../src/request/cancel.ts';
import {
  closeLoopbackServer,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';

test('Provider-backed integration daemon socket transport frames requests and normalizes malformed input', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) {
    return;
  }

  const observedRequests: DaemonRequest[] = [];
  const server = createSocketServer(async (req): Promise<DaemonResponse> => {
    observedRequests.push(req);
    return {
      ok: true,
      data: {
        command: req.command,
        requestId: req.meta?.requestId,
      },
    };
  });

  try {
    const port = await listenNetServer(server);
    const client = await connectSocket(port);

    const responses = await writeSocketRequests(client, [
      '',
      JSON.stringify({
        token: 'provider-scenario-token',
        session: 'default',
        command: 'session_list',
        positionals: [],
        meta: { requestId: 'req-socket-1' },
      }),
      '{not-json}',
    ]);

    assert.equal(observedRequests.length, 1);
    assert.equal(observedRequests[0]?.meta?.requestId, 'req-socket-1');
    assert.deepEqual(responses[0], {
      ok: true,
      data: {
        command: 'session_list',
        requestId: 'req-socket-1',
      },
    });
    assert.equal(responses[1]?.ok, false);
    assert.equal(responses[1]?.error?.code, 'UNKNOWN');

    const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    server.destroyConnections?.();
    await clientClosed;
    assert.equal(client.destroyed, true);

    const httpServer = http.createServer((_req, res) => {
      res.end('ok');
    });
    const httpPort = await listenHttpServer(httpServer);
    assert.equal(typeof httpPort, 'number');
    await closeLoopbackServer(httpServer);
  } finally {
    await closeLoopbackServer(server);
  }
});

// A socket client that vanishes mid-request must cancel that connection's
// in-flight request via its request-scoped signal — never through a global
// Apple-runner abort, and never touching another connection's request.
test('socket disconnect cancels only the disconnected connection in-flight request', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const disconnectedRequestId = 'req-socket-disconnected';
  const survivorRequestId = 'req-socket-survivor';
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
  let resolveDisconnectedDone: () => void = () => {};
  const disconnectedDone = new Promise<void>((resolve) => {
    resolveDisconnectedDone = resolve;
  });
  let survivorSignalAbortedDuringPeerTeardown = false;

  const server = createSocketServer(async (req: DaemonRequest): Promise<DaemonResponse> => {
    if (req.meta?.requestId === disconnectedRequestId) {
      const signal = getRequestSignal(disconnectedRequestId);
      assert.ok(signal, 'the disconnected request should have a registered signal');
      markDisconnectedStarted();
      await waitForAbort(signal);
      survivorSignalAbortedDuringPeerTeardown =
        getRequestSignal(survivorRequestId)?.aborted ?? false;
      resolveDisconnectedDone();
      releaseSurvivor();
      return { ok: true, data: {} };
    }
    markSurvivorStarted();
    await survivorReleased;
    return { ok: true, data: { survived: true } };
  });

  try {
    const port = await listenNetServer(server);
    const survivorClient = await connectSocket(port);
    survivorClient.write(
      `${JSON.stringify({
        token: 'provider-scenario-token',
        session: 'survivor',
        command: 'session_list',
        positionals: [],
        meta: { requestId: survivorRequestId },
      })}\n`,
    );
    await survivorStarted;

    const disconnectedClient = await connectSocket(port);
    disconnectedClient.write(
      `${JSON.stringify({
        token: 'provider-scenario-token',
        session: 'disconnected',
        command: 'session_list',
        positionals: [],
        meta: { requestId: disconnectedRequestId },
      })}\n`,
    );
    await disconnectedStarted;
    disconnectedClient.destroy();

    await disconnectedDone;
    assert.equal(
      survivorSignalAbortedDuringPeerTeardown,
      false,
      'a peer socket disconnect must not cancel another connection request',
    );
    survivorClient.destroy();
  } finally {
    await closeLoopbackServer(server);
  }
});

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function connectSocket(port: number): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

async function writeSocketRequests(
  socket: net.Socket,
  lines: string[],
): Promise<Array<{ ok?: boolean; data?: any; error?: any }>> {
  return await new Promise((resolve, reject) => {
    const responses: Array<{ ok?: boolean; data?: any; error?: any }> = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          responses.push(JSON.parse(line));
        }
        if (responses.length === 2) {
          resolve(responses);
          return;
        }
        idx = buffer.indexOf('\n');
      }
    });
    socket.once('error', reject);
    socket.write(`${lines.join('\n')}\n`);
  });
}
