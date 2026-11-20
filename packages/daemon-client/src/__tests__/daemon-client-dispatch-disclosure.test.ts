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
import { AppError, normalizeError } from '@agent-device/kernel/errors';
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
import {
  materializeRemoteArtifacts,
  sendRemoteScriptOpen,
} from '@agent-device/remote/daemon-artifacts';
import { handleDaemonHttpResponseBody } from '../daemon-client-rpc.ts';
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

// #4518: a caller abort after the RPC answer still stops the artifact delivery it started.
test('a caller abort after a record stop answer stops the artifact download', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'record stop cancellation')) return;
  const paths = statePaths();
  const cwd = path.join(paths.baseDir, 'cwd');
  fs.mkdirSync(cwd);
  const controller = new AbortController();
  const server = http.createServer((req, res) => {
    if (req.url?.includes('/artifacts/')) {
      res.write('video-');
      controller.abort();
      res.end('bytes');
      return;
    }
    req.resume();
    req.on('end', () => {
      const artifact = { artifactId: 'rec', field: 'outPath', fileName: 'demo.mp4' };
      res.end(
        JSON.stringify({ jsonrpc: '2.0', result: { ok: true, data: { artifacts: [artifact] } } }),
      );
    });
  });
  const port = await listenOnLoopback(server);
  try {
    const stop = request(PUBLIC_COMMANDS.record);
    await assert.rejects(
      sendRequest(
        { ...IDENTITY, baseUrl: `http://127.0.0.1:${port}` },
        { ...stop, positionals: ['stop'], meta: { ...stop.meta, cwd } },
        'http',
        paths,
        undefined,
        { host: createTestHostEnvironment(), signal: controller.signal },
      ),
      (error: unknown) => error instanceof AppError && error.details?.reason === 'request_canceled',
    );
    // The rejection waits for cleanup, so neither the file nor its staging remains.
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(paths.baseDir, { recursive: true, force: true });
  }
});

// #4518: no receipt settlement of a remote RPC-error answer publishes after the caller aborts. The
// reject callback runs only after that settlement finished, so the destination is read there.
test.for(['before the answer is handled', 'during the script download'] as const)(
  'a caller abort %s publishes nothing from an error answer receipt',
  async (when, t) => {
    if (await skipWhenLoopbackUnavailable(t, 'remote error answer cancellation')) return;
    const paths = statePaths();
    const destination = path.join(paths.baseDir, 'caller', 'journey.ad');
    const controller = new AbortController();
    let versionHits = 0;
    const server = http.createServer((req, res) => {
      if (req.url?.endsWith('/artifacts/open-v1')) return void res.end('open Demo\n');
      if (req.url?.endsWith('/artifacts/v2')) {
        versionHits += 1;
        if (when === 'during the script download') controller.abort();
        return void res.end('open Demo\nwait\n');
      }
      res.writeHead(404).end();
    });
    const port = await listenOnLoopback(server);
    const info = { ...IDENTITY, baseUrl: `http://127.0.0.1:${port}` };
    try {
      const publicationId = await openRecording(info.baseUrl, paths.baseDir, destination);
      if (when === 'before the answer is handled') controller.abort();
      const version = {
        field: 'savedScript',
        artifactType: 'session-script',
        artifactId: 'v2',
        scriptPublicationId: publicationId,
        scriptRevision: 2,
      };
      const details = {
        step: 1,
        command: 'wait',
        scriptDeliveryReceipt: { publicationId, version },
      };
      const body = JSON.stringify({
        jsonrpc: '2.0',
        error: {
          message: 'batch failed',
          data: { code: 'COMMAND_FAILED', message: 'batch failed', details },
        },
      });
      const settled = await new Promise<{ error: unknown; destination: string }>((resolve) => {
        handleDaemonHttpResponseBody(body, {
          info,
          req: {
            ...request('batch'),
            session: 'journey',
            flags: { batchSteps: [{ command: 'wait', input: {} }] },
          },
          stateDir: paths.baseDir,
          host: createTestHostEnvironment(),
          signal: controller.signal,
          resolve: () => resolve({ error: undefined, destination: '' }),
          reject: (error) => resolve({ error, destination: fs.readFileSync(destination, 'utf8') }),
        });
      });
      assert.equal(settled.destination, 'open Demo\n');
      if (when === 'before the answer is handled') {
        // An aborted request skips the settlement: nothing is fetched and nothing is disclosed.
        assert.equal(versionHits, 0);
        assert.equal((settled.error as AppError).details?.scriptDeliveryFailure, undefined);
      }
    } finally {
      await closeLoopbackServer(server);
      fs.rmSync(paths.baseDir, { recursive: true, force: true });
    }
  },
);

/** Opens a remote recording so the client holds its record and first version; returns its ID. */
async function openRecording(baseUrl: string, stateDir: string, destination: string) {
  let publicationId = '';
  const openRequest = {
    ...request('open'),
    session: 'journey',
    flags: { saveScript: true },
    meta: { clientArtifactPaths: { savedScript: destination } },
  };
  const opened = await sendRemoteScriptOpen(
    { baseUrl, token: IDENTITY.token, capabilities: ['script-artifacts'] },
    openRequest,
    stateDir,
    async (next) => {
      publicationId = next.meta?.scriptPublicationId as string;
      const artifact = {
        field: 'savedScript',
        artifactType: 'session-script' as const,
        artifactId: 'open-v1',
        scriptPublicationId: publicationId,
        scriptRevision: 1,
      };
      return { ok: true, data: { scriptPublicationId: publicationId, artifacts: [artifact] } };
    },
  );
  if (!opened.ok) throw new Error('open failed');
  await materializeRemoteArtifacts(
    { baseUrl, token: IDENTITY.token },
    openRequest,
    opened,
    createTestHostEnvironment(),
    stateDir,
  );
  assert.equal(fs.readFileSync(destination, 'utf8'), 'open Demo\n');
  return publicationId;
}

/** A record stop error whose details name local paths, nested paths and daemon warnings. */
const HOSTILE_RECORD_STOP_DETAILS = {
  reason: 'recording_stop_failed',
  outPath: '/client/x.mp4',
  telemetryPath: '/client/x.gesture-telemetry.json',
  chunkPath: '/client/x.part-001.mp4',
  chunks: [{ index: 1, path: '/client/x.part-001.mp4' }],
  savedScript: '/daemon/x.ad',
  scriptDeliveryFailure: { reason: 'script_delivery_failed' },
  recordingDestinationWarnings: [{ reason: 'recording_destination_not_requested' }],
  artifacts: [{ field: 'outPath', path: '/daemon/x.mp4', localPath: '/client/x.mp4' }],
  nested: { localPath: '/client/elsewhere.mp4' },
  warnings: ['daemon note'],
};

/** A remote record stop error keeps only its named facts, with the daemon's warning text apart. */
function assertOnlyRecordStopFacts(error: AppError): void {
  for (const view of [error.details, normalizeError(error).details]) {
    assert.equal(view?.reason, 'recording_stop_failed');
    assert.deepEqual(view?.daemonWarnings, ['daemon note']);
    for (const field of [
      'outPath',
      'telemetryPath',
      'chunkPath',
      'chunks',
      'savedScript',
      'scriptDeliveryFailure',
      'recordingDestinationWarnings',
      'artifacts',
      'nested',
      'warnings',
    ]) {
      assert.equal(view?.[field], undefined, field);
    }
  }
}

/** Runs one answer body through the RPC adapter and returns what the caller receives. */
async function adapt(baseUrl: string | undefined, cwd: string, body: unknown) {
  return await new Promise<{ response?: unknown; error?: unknown }>((resolve) => {
    handleDaemonHttpResponseBody(JSON.stringify(body), {
      info: baseUrl === undefined ? IDENTITY : { ...IDENTITY, baseUrl },
      req: { ...request(PUBLIC_COMMANDS.record), positionals: ['stop'], meta: { cwd } },
      stateDir: path.join(cwd, 'state'),
      host: createTestHostEnvironment(),
      resolve: (response) => resolve({ response }),
      reject: (error) => resolve({ error }),
    });
  });
}

// #4518: only this client's own delivery may report a cwd write or a published script path.
test('a remote record stop error cannot carry client-owned fields to the caller', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'client-owned error details')) return;
  const cwd = mkdtempForTestSync('agent-device-peer-details-');
  const server = http.createServer((_req, res) => res.writeHead(500).end());
  const port = await listenOnLoopback(server);
  try {
    const details = HOSTILE_RECORD_STOP_DETAILS;
    const { error } = await adapt(`http://127.0.0.1:${port}`, cwd, {
      jsonrpc: '2.0',
      error: {
        message: 'stop failed',
        data: { code: 'COMMAND_FAILED', message: 'stop failed', details },
      },
    });
    assert.ok(error instanceof AppError);
    assertOnlyRecordStopFacts(error);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a local recording delivery failure keeps its own cwd fallback warnings', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'local delivery failure warnings')) return;
  const cwd = mkdtempForTestSync('agent-device-local-delivery-');
  const server = http.createServer((req, res) => {
    if (req.url?.includes('telemetry')) return void res.writeHead(500).end();
    res.end('video');
  });
  const port = await listenOnLoopback(server);
  try {
    const artifacts = [
      { artifactId: 'video', field: 'outPath', fileName: 'demo.mp4' },
      { artifactId: 'telemetry', field: 'telemetryPath', fileName: 'demo.json' },
    ];
    const { error } = await adapt(`http://127.0.0.1:${port}`, cwd, {
      jsonrpc: '2.0',
      result: { ok: true, data: { artifacts } },
    });
    assert.ok(error instanceof AppError);
    const written = path.join(fs.realpathSync(cwd), 'demo.mp4');
    const reported = normalizeError(error).details?.recordingDestinationWarnings as
      | Array<{ path: string }>
      | undefined;
    assert.equal(fs.realpathSync(reported?.[0]?.path ?? ''), written);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a local daemon HTTP error keeps its repair savedScript', async () => {
  const cwd = mkdtempForTestSync('agent-device-local-details-');
  try {
    const details = { savedScript: '/work/repair.ad', reason: 'session_close_script_failed' };
    const { error } = await adapt(undefined, cwd, {
      jsonrpc: '2.0',
      error: {
        message: 'close failed',
        data: { code: 'COMMAND_FAILED', message: 'close failed', details },
      },
    });
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.savedScript, '/work/repair.ad');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a remote result artifact that is not downloaded names no local path', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'peer artifact localPath')) return;
  const cwd = mkdtempForTestSync('agent-device-peer-localpath-');
  try {
    const artifact = { field: 'outPath', path: '/daemon/x.mp4', localPath: '/client/x.mp4' };
    const { response } = await adapt('http://127.0.0.1:9', cwd, {
      jsonrpc: '2.0',
      result: { ok: true, data: { artifacts: [artifact] } },
    });
    const data = (response as { ok: boolean; data?: Record<string, unknown> }).data;
    assert.deepEqual(data?.artifacts, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// #4518: a remote result whose ok is anything but true leaves through the same strip as a JSON-RPC
// error.
test.for([
  { name: 'ok:false', ok: { ok: false } },
  { name: 'no ok', ok: {} },
  { name: 'ok:null', ok: { ok: null } },
  { name: 'ok:0', ok: { ok: 0 } },
  { name: "ok:''", ok: { ok: '' } },
])('a remote $name result cannot carry client-owned fields to the caller', async ({ ok }, t) => {
  if (await skipWhenLoopbackUnavailable(t, 'client-owned ok:false details')) return;
  const cwd = mkdtempForTestSync('agent-device-peer-result-');
  const server = http.createServer((_req, res) => res.writeHead(500).end());
  const port = await listenOnLoopback(server);
  try {
    const details = HOSTILE_RECORD_STOP_DETAILS;
    const { response, error } = await adapt(`http://127.0.0.1:${port}`, cwd, {
      jsonrpc: '2.0',
      result: { ...ok, error: { code: 'COMMAND_FAILED', message: 'x', details } },
    });
    assert.equal(response, undefined);
    assert.ok(error instanceof AppError);
    assertOnlyRecordStopFacts(error);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a local daemon ok:false result keeps its repair savedScript', async () => {
  const cwd = mkdtempForTestSync('agent-device-local-result-');
  try {
    const details = { savedScript: '/work/repair.ad' };
    const { response } = await adapt(undefined, cwd, {
      jsonrpc: '2.0',
      result: { ok: false, error: { code: 'COMMAND_FAILED', message: 'close failed', details } },
    });
    const failed = response as { ok: boolean; error?: { details?: Record<string, unknown> } };
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.details?.savedScript, '/work/repair.ad');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test.for([
  { name: 'null', result: null },
  { name: 'a string', result: 'x' },
  { name: 'an array', result: [{ savedScript: '/daemon/x.ad' }] },
  { name: 'an object without ok or error', result: { savedScript: '/daemon/x.ad' } },
])('a remote result that is $name is invalid and carries no peer fields', async ({ result }) => {
  const cwd = mkdtempForTestSync('agent-device-peer-invalid-');
  try {
    const { response, error } = await adapt('http://127.0.0.1:9', cwd, { jsonrpc: '2.0', result });
    assert.equal(response, undefined);
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, 'daemon_response_invalid');
    assert.equal(error.details?.savedScript, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// #4518: an error code or message that is not a string still settles the request.
test('a remote error with a non-string code and message still rejects', async () => {
  const cwd = mkdtempForTestSync('agent-device-peer-code-');
  try {
    const { error } = await adapt('http://127.0.0.1:9', cwd, {
      jsonrpc: '2.0',
      error: {
        message: { toString: 1 },
        data: { code: { toString: 1 }, message: { toString: 1 } },
      },
    });
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'COMMAND_FAILED');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// #4518: a canceled request fetches no diagnostics record from a remote error answer.
test('a canceled remote error answer fetches no diagnostics record', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'diagnostics after cancel')) return;
  const cwd = mkdtempForTestSync('agent-device-diagnostics-cancel-');
  let diagnosticsHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.includes('/diagnostics')) diagnosticsHits += 1;
    res.end('{}');
  });
  const port = await listenOnLoopback(server);
  try {
    const controller = new AbortController();
    controller.abort();
    const error = await new Promise<unknown>((resolve) => {
      handleDaemonHttpResponseBody(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            message: 'stop failed',
            data: {
              code: 'COMMAND_FAILED',
              message: 'stop failed',
              diagnosticsRecord: { session: 's', requestId: 'r1' },
            },
          },
        }),
        {
          info: { ...IDENTITY, baseUrl: `http://127.0.0.1:${port}` },
          req: { ...request(PUBLIC_COMMANDS.record), positionals: ['stop'], meta: { cwd } },
          stateDir: path.join(cwd, 'state'),
          host: createTestHostEnvironment(),
          signal: controller.signal,
          resolve: () => resolve(undefined),
          reject: resolve,
        },
      );
    });
    assert.ok(error instanceof AppError);
    assert.equal(diagnosticsHits, 0);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
