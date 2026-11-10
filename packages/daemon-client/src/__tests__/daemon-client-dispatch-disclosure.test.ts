// Every transport failure discloses whether the request can have reached the device. Each row
// drives the real transport against a loopback stand-in daemon that fails at one point of the
// exchange; the verdict comes from the command's declared effect once the request was sent.

import type { DaemonWireRequest } from '@agent-device/contracts/command';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { DaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  assertDispatchDisclosureDriversMatchRows,
  closeLoopbackServer,
  createTestHostEnvironment,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
  listenOnLoopback,
  type LoopbackServer,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { sendRequest } from '../daemon-client-transport.ts';
import type { DaemonInfo } from '../daemon-client-metadata.ts';

const IDENTITY = { token: 'test-token', pid: process.pid, processStartTime: 'stand-in' };

function statePaths(): DaemonPaths {
  const baseDir = mkdtempForTestSync('agent-device-dispatch-disclosure-test');
  return {
    baseDir,
    infoPath: path.join(baseDir, 'daemon.json'),
    lockPath: path.join(baseDir, 'daemon.lock'),
    logPath: path.join(baseDir, 'daemon.log'),
    allocationsDir: path.join(baseDir, 'allocations'),
  } as DaemonPaths;
}

function request(command: string): DaemonWireRequest {
  return {
    token: IDENTITY.token,
    session: 'default',
    command,
    positionals: [],
    flags: {},
    meta: { requestId: `dispatch-${command}` },
  };
}

/** A socket daemon that reads one request line and then does `onRequest` with its socket. */
async function socketDaemon(onRequest: (socket: net.Socket) => void): Promise<LoopbackServer> {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => onRequest(socket));
  });
  await listenOnLoopback(server);
  return server;
}

function portOf(server: LoopbackServer): number {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function overSocket(
  command: string,
  onRequest: (socket: net.Socket) => void,
): Promise<unknown> {
  const server = await socketDaemon(onRequest);
  try {
    return await sendRequest(
      { ...IDENTITY, port: portOf(server) },
      request(command),
      'socket',
      statePaths(),
      undefined,
      { host: createTestHostEnvironment() },
    );
  } finally {
    await closeLoopbackServer(server);
  }
}

async function overHttp(info: (port: number) => DaemonInfo, timeoutMs?: number): Promise<unknown> {
  const server: LoopbackServer = http.createServer((req) => {
    req.on('error', () => {});
    // Reads the whole request, then (without a timeout) drops the connection before replying.
    req.on('end', () => {
      if (timeoutMs === undefined) req.socket.destroy();
    });
    req.resume();
  });
  const port = await listenOnLoopback(server);
  try {
    return await sendRequest(
      info(port),
      request(PUBLIC_COMMANDS.press),
      'http',
      statePaths(),
      timeoutMs,
      { host: createTestHostEnvironment() },
    );
  } finally {
    await closeLoopbackServer(server);
  }
}

/** A remote daemon that answers the request with one artifact and then refuses its download. */
async function artifactFetchAfterAnswer(): Promise<unknown> {
  const server: LoopbackServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'dispatch-press',
          result: {
            ok: true,
            data: {
              artifacts: [{ artifactId: 'gone', field: 'path', fileName: 'screen.png' }],
            },
          },
        }),
      );
    });
  });
  const port = await listenOnLoopback(server);
  try {
    return await sendRequest(
      { ...IDENTITY, baseUrl: `http://127.0.0.1:${port}` },
      request(PUBLIC_COMMANDS.press),
      'http',
      statePaths(),
      undefined,
      { host: createTestHostEnvironment() },
    );
  } finally {
    await closeLoopbackServer(server);
  }
}

/** A press sent to a port nothing listens on, so the connection fails before anything is sent. */
async function refusedBeforeSend(transport: 'socket' | 'http'): Promise<unknown> {
  const server = net.createServer();
  const port = await listenOnLoopback(server);
  await closeLoopbackServer(server);
  return await sendRequest(
    transport === 'socket' ? { ...IDENTITY, port } : { ...IDENTITY, httpPort: port },
    request(PUBLIC_COMMANDS.press),
    transport,
    statePaths(),
    undefined,
    { host: createTestHostEnvironment() },
  );
}

type Details = Record<string, unknown> | undefined;

type Driver = Readonly<{
  run: () => Promise<unknown>;
  /** Whether the failure came from the intended path, read from its typed details. */
  failedOn: (details: Details) => boolean;
}>;

const reasonIn =
  (...reasons: string[]) =>
  (details: Details): boolean =>
    reasons.includes(String(details?.reason));

/** A transport failure that records whether the request left the client. */
const transportFailure =
  (reason: string, sent: boolean) =>
  (details: Details): boolean =>
    details?.reason === reason && details.daemonRequestSent === sent;

// A socket closed without a reply surfaces as either reason, depending on timing.
const CLOSED_WITHOUT_REPLY = ['daemon_transport_failure', 'daemon_response_invalid'];

const DRIVERS: Record<string, Driver> = {
  'daemon-client.socket-closed-after-send': {
    run: () => overSocket(PUBLIC_COMMANDS.press, (socket) => socket.destroy()),
    failedOn: reasonIn(...CLOSED_WITHOUT_REPLY),
  },
  'daemon-client.http-reset-after-send': {
    run: () => overHttp((port) => ({ ...IDENTITY, httpPort: port })),
    failedOn: transportFailure('daemon_transport_failure', true),
  },
  'daemon-client.invalid-response-after-send': {
    run: () =>
      overSocket(PUBLIC_COMMANDS.press, (socket) => socket.end('not a json-rpc response\n')),
    failedOn: reasonIn('daemon_response_invalid'),
  },
  'daemon-client.timeout-after-send': {
    run: () => overHttp((port) => ({ ...IDENTITY, baseUrl: `http://127.0.0.1:${port}` }), 60),
    failedOn: transportFailure('daemon_transport_timeout', true),
  },
  'daemon-client.read-failure-after-send': {
    run: () => overSocket(PUBLIC_COMMANDS.snapshot, (socket) => socket.destroy()),
    failedOn: reasonIn(...CLOSED_WITHOUT_REPLY),
  },
  'daemon-client.refused-before-send': {
    run: () => refusedBeforeSend('socket'),
    failedOn: transportFailure('daemon_transport_failure', false),
  },
  'daemon-client.http-refused-before-send': {
    run: () => refusedBeforeSend('http'),
    failedOn: transportFailure('daemon_transport_failure', false),
  },
  'daemon-client.delegated-composite-after-send': {
    run: () => overSocket(PUBLIC_COMMANDS.batch, (socket) => socket.destroy()),
    failedOn: reasonIn(...CLOSED_WITHOUT_REPLY),
  },
  'daemon-client.artifact-fetch-after-answer': {
    run: artifactFetchAfterAnswer,
    // The artifact download's own failure, after the daemon's successful answer.
    failedOn: (details) => details?.artifactId === 'gone' && details.statusCode === 404,
  },
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every daemon-client dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DRIVERS));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const driver = DRIVERS[row.id];
    assert.ok(driver, `no driver for ${row.id}`);
    await assert.rejects(driver.run(), (error: unknown) => {
      assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
      assert.ok(
        driver.failedOn(error.details),
        `${row.id} failed off its intended path: ${error.message}`,
      );
      assert.equal(error.details?.dispatched, row.dispatched);
      return true;
    });
  });
}

// The registry gives a command without a declared effect no verdict, at the daemon and here alike,
// so the CLI prints no dispatch fact instead of a snapshot step for a request that has no screen.
test('a sent request for a command without a declared effect gets no dispatch verdict', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  await assert.rejects(
    overSocket(PUBLIC_COMMANDS.devices, (socket) => socket.destroy()),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.ok(CLOSED_WITHOUT_REPLY.includes(String(error.details?.reason)));
      assert.equal('dispatched' in (error.details ?? {}), false);
      return true;
    },
  );
});
