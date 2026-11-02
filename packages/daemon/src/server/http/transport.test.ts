import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'vitest';
import { createSocketServer, listenHttpServer, listenNetServer } from './transport.ts';
import { DAEMON_REQUEST_MAX_BYTES } from '@agent-device/contracts/daemon-http';
import {
  clearRequestAbortRegistration,
  getRequestSignal,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
import { applicationLifecycleExecutionFromRequest } from '../../sessions/application-lifecycle-execution.ts';
import { closeLoopbackServer, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';

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
        meta: {
          requestId: 'req-socket-1',
          devicePin: {
            selector: { platform: 'ios', udid: 'SIM-1' },
            source: { kind: 'project', path: '/project/agent-device.json' },
          },
        },
        internal: {
          observationOnly: true,
          replayPlanStep: true,
        },
      }),
      '{not-json}',
    ]);

    assert.equal(observedRequests.length, 1);
    assert.equal(observedRequests[0]?.meta?.requestId, 'req-socket-1');
    assert.deepEqual(observedRequests[0]?.meta?.devicePin, {
      selector: { platform: 'ios', udid: 'SIM-1' },
      source: { kind: 'project', path: '/project/agent-device.json' },
    });
    assert.equal(
      observedRequests[0]?.internal,
      undefined,
      'socket clients must not forge daemon-internal request capabilities',
    );
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

const OVERSIZED_SOCKET_REQUESTS = [
  { name: 'an unterminated request', request: 'x'.repeat(DAEMON_REQUEST_MAX_BYTES + 1) },
  {
    name: 'a framed JSON request',
    request: `${JSON.stringify({ command: 'session_list', pad: 'x'.repeat(DAEMON_REQUEST_MAX_BYTES) })}\n`,
  },
  {
    // Two bytes per character: under the limit in string length, over it in bytes.
    name: 'a framed multibyte request',
    request: `${JSON.stringify({ command: 'session_list', pad: '\u00e9'.repeat(DAEMON_REQUEST_MAX_BYTES / 2) })}\n`,
  },
];

test.for(OVERSIZED_SOCKET_REQUESTS)(
  'socket transport refuses $name past the byte limit and closes',
  async ({ request }, t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    let handled = 0;
    const server = createSocketServer(async (): Promise<DaemonResponse> => {
      handled += 1;
      return { ok: true, data: {} };
    });
    try {
      const client = await connectSocket(await listenNetServer(server));
      client.setEncoding('utf8');
      let received = '';
      client.on('data', (chunk) => {
        received += chunk;
      });
      const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
      client.on('error', () => {});
      client.write(request);
      await closed;
      const response = JSON.parse(received.trim()) as DaemonResponse;
      assert.equal(response.ok, false);
      assert.equal(response.ok ? undefined : response.error.code, 'INVALID_ARGS');
      assert.equal(handled, 0);
    } finally {
      await closeLoopbackServer(server);
    }
  },
);

test('socket transport answers a framed request larger than 1 MiB and under the request limit', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const server = createSocketServer(async (req): Promise<DaemonResponse> => ({
    ok: true,
    data: { bytes: req.flags?.replayScriptSource?.files['flow.ad']?.length },
  }));
  try {
    const client = await connectSocket(await listenNetServer(server));
    // A replay bundle may reach 2 MiB; the old 1 MiB socket cap refused it.
    const flow = 'x'.repeat(2 * 1024 * 1024);
    const replayScriptSource = { entry: 'flow.ad', files: { 'flow.ad': flow } };
    const [response] = await writeSocketRequests(
      client,
      [JSON.stringify({ command: 'replay', positionals: [], flags: { replayScriptSource } })],
      1,
    );
    client.destroy();
    assert.deepEqual(response, { ok: true, data: { bytes: flow.length } });
  } finally {
    await closeLoopbackServer(server);
  }
});

test('socket transport answers the complete requests framed before an oversized one, then refuses it', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const handled: string[] = [];
  const firstRequest = `${JSON.stringify({ command: 'session_list', positionals: [] })}\n`;
  let oversizedReceived = () => {};
  const oversizedArrived = new Promise<void>((resolve) => {
    oversizedReceived = resolve;
  });
  // The first request is still in flight when the transport has read past the limit.
  const server = createSocketServer(async (req): Promise<DaemonResponse> => {
    handled.push(req.command);
    await oversizedArrived;
    return { ok: true, data: { command: req.command } };
  });
  server.on('connection', (socket: net.Socket) => {
    let receivedBytes = 0;
    socket.on('data', (chunk: string) => {
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes >= firstRequest.length + DAEMON_REQUEST_MAX_BYTES + 1) oversizedReceived();
    });
  });
  try {
    const client = await connectSocket(await listenNetServer(server));
    client.setEncoding('utf8');
    let received = '';
    client.on('data', (chunk) => {
      received += chunk;
    });
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.on('error', () => {});
    client.write(firstRequest);
    client.write('x'.repeat(DAEMON_REQUEST_MAX_BYTES + 1));
    await closed;
    const responses = received
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as DaemonResponse);
    assert.deepEqual(handled, ['session_list']);
    assert.equal(responses.length, 2);
    assert.deepEqual(responses[0], { ok: true, data: { command: 'session_list' } });
    assert.equal(responses[1]?.ok ? undefined : responses[1]?.error.code, 'INVALID_ARGS');
  } finally {
    await closeLoopbackServer(server);
  }
});

test('socket transport refuses a non-string positional before dispatch', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) {
    return;
  }
  const observedRequests: DaemonRequest[] = [];
  const server = createSocketServer(async (req): Promise<DaemonResponse> => {
    observedRequests.push(req);
    return { ok: true, data: {} };
  });

  try {
    const port = await listenNetServer(server);
    const client = await connectSocket(port);
    const request = (positionals: unknown[]) =>
      JSON.stringify({ token: 't', session: 'default', command: 'clipboard', positionals });

    const responses = await writeSocketRequests(
      client,
      [request(['write', null]), request(['hi', 5]), request(['write', ''])],
      3,
    );

    for (const response of responses.slice(0, 2)) {
      assert.equal(response?.ok, false);
      assert.equal(response?.error?.code, 'INVALID_ARGS');
      assert.equal(response?.error?.details?.reason, 'malformed_request');
      assert.equal(response?.error?.details?.dispatched, 'no');
      assert.match(response?.error?.message ?? '', /positionals\[1\]: Expected a string/);
    }
    // `""` is a string, so the clear request still reaches its handler.
    assert.equal(responses[2]?.ok, true);
    assert.deepEqual(
      observedRequests.map((req) => req.positionals),
      [['write', '']],
    );
    client.destroy();
  } finally {
    await closeLoopbackServer(server);
  }
});

test.for([
  ['omitted', undefined, 'default', true],
  ['blank', '  ', 'default', true],
  ['named', 'agent-a', 'agent-a', undefined],
] as const)(
  'the socket records a session that is %s',
  async ([_label, session, resolvedSession, sessionOmitted], t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;

    const observedRequests: DaemonRequest[] = [];
    const server = createSocketServer(async (req): Promise<DaemonResponse> => {
      observedRequests.push(req);
      return { ok: true, data: {} };
    });

    try {
      const client = await connectSocket(await listenNetServer(server));
      await writeSocketRequests(
        client,
        [JSON.stringify({ token: 'token', session, command: 'session_list', positionals: [] })],
        1,
      );
      client.destroy();
      assert.equal(observedRequests.length, 1);
      assert.equal(observedRequests[0]?.session, resolvedSession);
      assert.equal(observedRequests[0]?.internal?.sessionOmitted, sessionOmitted);
    } finally {
      await closeLoopbackServer(server);
    }
  },
);

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

/** The deadline an `open` running under `requestId` would carry. */
function openDeadlineAtMs(requestId: string | undefined): number | undefined {
  return applicationLifecycleExecutionFromRequest(
    {
      token: 'provider-scenario-token',
      session: 'default',
      command: 'open',
      positionals: ['com.example.app'],
      meta: { requestId },
    },
    '/tmp/request.log',
  ).requestDeadlineAtMs;
}

test('a socket-admitted open --timeout moves its deadline with the envelope it widens', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let deadlineAtMs: number | undefined;
  const server = createSocketServer(async (req): Promise<DaemonResponse> => {
    deadlineAtMs = applicationLifecycleExecutionFromRequest(
      req,
      '/tmp/request.log',
    ).requestDeadlineAtMs;
    return { ok: true, data: {} };
  });
  try {
    const client = await connectSocket(await listenNetServer(server));
    const sentAtMs = Date.now();
    await writeSocketRequests(
      client,
      [
        JSON.stringify({
          token: 'provider-scenario-token',
          session: 'default',
          command: 'open',
          positionals: ['com.example.app'],
          flags: { timeoutMs: 120_000 },
          meta: { requestId: 'socket-open-widened-deadline' },
        }),
      ],
      1,
    );
    const answeredAtMs = Date.now();
    client.destroy();
    assert.ok(deadlineAtMs !== undefined, 'the open must carry a deadline');
    assert.ok(deadlineAtMs >= sentAtMs + 120_000 && deadlineAtMs <= answeredAtMs + 120_000);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('an attempt nested under a test request without a client envelope has no deadline', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let attemptDeadlineAtMs: number | undefined = Number.NaN;
  const server = createSocketServer(async (req): Promise<DaemonResponse> => {
    const registration = registerRequestAbort('socket-test-attempt', req.meta?.requestId);
    try {
      attemptDeadlineAtMs = openDeadlineAtMs('socket-test-attempt');
    } finally {
      clearRequestAbortRegistration(registration);
    }
    return { ok: true, data: {} };
  });
  try {
    const client = await connectSocket(await listenNetServer(server));
    await writeSocketRequests(
      client,
      [
        JSON.stringify({
          token: 'provider-scenario-token',
          session: 'default',
          command: 'test',
          positionals: ['flows'],
          meta: { requestId: 'socket-test-suite' },
        }),
      ],
      1,
    );
    client.destroy();
    assert.equal(attemptDeadlineAtMs, undefined);
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
  expectedResponses = 2,
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
        if (responses.length === expectedResponses) {
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

test('Provider-backed integration socket rejects malformed device pins before invoking the handler', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const observed: DaemonRequest[] = [];
  const server = createSocketServer(async (req) => {
    observed.push(req);
    return { ok: true, data: {} };
  });
  try {
    const port = await listenNetServer(server);
    const client = await connectSocket(port);
    const responses = await writeSocketRequests(
      client,
      [null, false, {}, { selector: {} }].map((devicePin) =>
        JSON.stringify({ command: 'capabilities', positionals: [], meta: { devicePin } }),
      ),
      4,
    );
    assert.equal(responses.length, 4);
    assert.equal(observed.length, 0);
    for (const response of responses) {
      assert.equal(response.error?.code, 'INVALID_ARGS');
      assert.equal(response.error?.details?.reason, 'invalid_device_pin');
    }
    client.end();
  } finally {
    server.destroyConnections?.();
    await closeLoopbackServer(server);
  }
});
