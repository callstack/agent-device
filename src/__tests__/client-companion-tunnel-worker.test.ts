import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, test } from 'vitest';
import {
  buildCompanionPayload,
  runCompanionTunnelWorker,
} from '../client/client-companion-tunnel-worker.ts';
import { closeLoopbackServer, listenOnLoopback } from './test-utils/index.ts';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type CloseFrame = {
  code?: number;
  reason?: string;
};

type ParsedWebSocketFrame = {
  opcode: number;
  payload: Buffer;
  nextOffset: number;
};

type CompanionWorkerProcess = {
  earlyExit: Promise<never>;
  readStderr: () => string;
  stop: () => Promise<void>;
  waitForExit: (
    label: string,
    timeoutMs?: number,
  ) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  return Buffer.concat([
    Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]),
    payload,
  ]);
}

function encodeCloseFrame(code = 1000, reason = ''): Buffer {
  const reasonBuffer = Buffer.from(reason, 'utf8');
  const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
  }
  return Buffer.concat([
    Buffer.from([0x88, 126, payload.length >> 8, payload.length & 0xff]),
    payload,
  ]);
}

function parseWebSocketFrame(pending: Buffer, startOffset: number): ParsedWebSocketFrame | null {
  if (startOffset + 2 > pending.length) return null;

  const first = pending[startOffset]!;
  const second = pending[startOffset + 1]!;
  const opcode = first & 0x0f;
  let offset = startOffset + 2;
  let length = second & 0x7f;

  if (length === 126) {
    if (offset + 2 > pending.length) return null;
    length = pending.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    throw new Error('Large WebSocket frames are not supported in this test.');
  }

  const masked = (second & 0x80) !== 0;
  const maskLength = masked ? 4 : 0;
  if (offset + maskLength + length > pending.length) return null;

  const mask = masked ? pending.subarray(offset, offset + 4) : null;
  offset += maskLength;
  const payload = decodeWebSocketPayload(pending.subarray(offset, offset + length), mask);

  return { opcode, payload, nextOffset: offset + length };
}

function decodeWebSocketPayload(payload: Buffer, mask: Buffer | null): Buffer {
  if (!mask) return payload;

  const decoded = Buffer.from(payload);
  for (let index = 0; index < decoded.length; index += 1) {
    decoded[index]! ^= mask[index % 4]!;
  }
  return decoded;
}

function parseCloseFrame(payload: Buffer): CloseFrame {
  if (payload.length < 2) return {};

  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString('utf8'),
  };
}

function emitWebSocketFrame(
  frame: ParsedWebSocketFrame,
  onText: (text: string) => void,
  onClose?: (frame: CloseFrame) => void,
): void {
  if (frame.opcode === 0x1) {
    onText(frame.payload.toString('utf8'));
    return;
  }
  if (frame.opcode === 0x8 && onClose) {
    onClose(parseCloseFrame(frame.payload));
  }
}

function attachWebSocketFrameParser(
  socket: NodeJS.WritableStream & NodeJS.EventEmitter,
  onText: (text: string) => void,
  onClose?: (frame: CloseFrame) => void,
): void {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    let offset = 0;
    for (;;) {
      const frame = parseWebSocketFrame(pending, offset);
      if (!frame) break;
      offset = frame.nextOffset;
      emitWebSocketFrame(frame, onText, onClose);
    }
    pending = pending.subarray(offset);
  });
}

function acceptWebSocketUpgrade(req: http.IncomingMessage, socket: Duplex): boolean {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return false;
  }
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );
  return true;
}

function writeNotFound(res: http.ServerResponse): void {
  res.writeHead(404);
  res.end('not found');
}

function writeSuccessfulRegistration(res: http.ServerResponse, bridgePort: number): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      data: { ws_url: `ws://127.0.0.1:${bridgePort}/bridge` },
    }),
  );
}

async function listenNotFoundServer(): Promise<number> {
  const server = http.createServer((_, res) => writeNotFound(res));
  cleanupTasks.push(() => closeLoopbackServer(server));
  return listenOnLoopback(server);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForClose = () =>
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      child.once('close', () => resolve(true));
    });
  const closePromise = waitForClose();
  child.kill('SIGTERM');
  const exited = await Promise.race([closePromise, delay(2_000).then(() => false)]);
  if (exited) return;
  const killClosePromise = waitForClose();
  child.kill('SIGKILL');
  await killClosePromise;
}

function spawnMetroCompanionWorker(options: {
  bearerToken?: string;
  bridgePort?: number;
  localPort?: number;
  serverBaseUrl?: string;
  localBaseUrl?: string;
  statePath?: string;
  unregisterPath?: string;
}): CompanionWorkerProcess {
  const serverBaseUrl = options.serverBaseUrl ?? `http://127.0.0.1:${options.bridgePort}`;
  const localBaseUrl = options.localBaseUrl ?? `http://127.0.0.1:${options.localPort}`;
  const companion = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      'src/client/companion-tunnel.ts',
      '--agent-device-run-metro-companion',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_DEVICE_COMPANION_TUNNEL_SERVER_BASE_URL: serverBaseUrl,
        AGENT_DEVICE_COMPANION_TUNNEL_BEARER_TOKEN: options.bearerToken ?? 'test-token',
        AGENT_DEVICE_COMPANION_TUNNEL_LOCAL_BASE_URL: localBaseUrl,
        AGENT_DEVICE_COMPANION_TUNNEL_REGISTER_PATH: '/api/metro/companion/register',
        AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_TENANT_ID: 'tenant-1',
        AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_RUN_ID: 'run-1',
        AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_LEASE_ID: 'lease-1',
        ...(options.statePath
          ? { AGENT_DEVICE_COMPANION_TUNNEL_STATE_PATH: options.statePath }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  cleanupTasks.push(() => stopChild(companion));

  let stderr = '';
  companion.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return {
    get earlyExit() {
      return new Promise<never>((_, reject) => {
        companion.once('exit', (code, signal) => {
          reject(
            new Error(
              `Metro companion exited unexpectedly with code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
            ),
          );
        });
      });
    },
    readStderr: () => stderr,
    stop: async () => await stopChild(companion),
    waitForExit: (label, timeoutMs = 5_000) =>
      waitFor(
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          companion.once('exit', (code, signal) => resolve({ code, signal }));
        }),
        timeoutMs,
        label,
      ),
  };
}

function startMetroCompanionWorker(options: {
  bearerToken?: string;
  bridgePort: number;
  localPort: number;
  serverBaseUrl?: string;
  localBaseUrl?: string;
  statePath?: string;
  unregisterPath?: string;
}): CompanionWorkerProcess {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-companion-worker-'));
  const statePath = options.statePath ?? path.join(tempRoot, 'metro-companion.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, '{}', 'utf8');
  }

  const serverBaseUrl = options.serverBaseUrl ?? `http://127.0.0.1:${options.bridgePort}`;
  const localBaseUrl = options.localBaseUrl ?? `http://127.0.0.1:${options.localPort}`;
  const done = runCompanionTunnelWorker(
    {
      serverBaseUrl,
      bearerToken: options.bearerToken ?? 'test-token',
      localBaseUrl,
      registerPath: '/api/metro/companion/register',
      bridgeScope: {
        tenantId: 'tenant-1',
        runId: 'run-1',
        leaseId: 'lease-1',
      },
      statePath,
      unregisterPath: options.unregisterPath,
    },
    {
      leaseCheckIntervalMs: 25,
      reconnectDelayMs: 25,
    },
  );
  const stop = async () => {
    fs.rmSync(statePath, { force: true });
    try {
      await waitFor(
        done.then(() => undefined),
        2_000,
        'in-process companion worker stop',
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };
  cleanupTasks.push(stop);

  return {
    get earlyExit() {
      return done.then(
        () => {
          throw new Error('Metro companion worker exited unexpectedly.');
        },
        (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
      );
    },
    readStderr: () => '',
    stop,
    waitForExit: (label, timeoutMs = 5_000) =>
      waitFor(
        done.then(() => ({ code: 0, signal: null })),
        timeoutMs,
        label,
      ),
  };
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (!task) continue;
    await task();
  }
});

test('companion payload includes React DevTools session and device port', () => {
  assert.deepEqual(
    buildCompanionPayload({
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8097/',
      bridgeScope: {
        tenantId: 'tenant-1',
        runId: 'run-1',
        leaseId: 'lease-1',
      },
      session: 'default',
      devicePort: 8097,
      registerPath: '/api/react-devtools/companion/register',
      unregisterPath: '/api/react-devtools/companion/unregister',
    }),
    {
      tenantId: 'tenant-1',
      runId: 'run-1',
      leaseId: 'lease-1',
      session: 'default',
      local_base_url: 'http://127.0.0.1:8097',
      device_port: 8097,
    },
  );
});

test('metro companion worker proxies websocket frames to the local upstream server', async () => {
  const upstreamMessage = createDeferred<string>();
  const bridgePong = createDeferred<void>();
  const bridgeSocketReady = createDeferred<NodeJS.WritableStream>();
  const registrationBody = createDeferred<Record<string, unknown>>();
  const bridgeOpen = createDeferred<void>();
  const bridgeFrame = createDeferred<string>();
  const bridgeClose = createDeferred<CloseFrame>();
  let upstreamSocketRef: Duplex | null = null;
  let bridgeSocketRef: Duplex | null = null;

  const upstreamServer = http.createServer((_, res) => writeNotFound(res));
  upstreamServer.on('upgrade', (req, socket) => {
    if (req.url !== '/echo') {
      socket.destroy();
      return;
    }
    upstreamSocketRef = socket;
    if (!acceptWebSocketUpgrade(req, socket)) return;
    attachWebSocketFrameParser(
      socket,
      (text) => {
        upstreamMessage.resolve(text);
        socket.write(encodeTextFrame(text));
      },
      () => {
        socket.write(encodeCloseFrame(1000, 'upstream done'));
        socket.end();
      },
    );
  });
  cleanupTasks.push(() => closeLoopbackServer(upstreamServer));
  cleanupTasks.push(async () => {
    upstreamSocketRef?.destroy();
  });
  const upstreamPort = await listenOnLoopback(upstreamServer);

  const bridgeServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/metro/companion/register') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        registrationBody.resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        writeSuccessfulRegistration(res, bridgePort);
      });
      return;
    }
    writeNotFound(res);
  });
  bridgeServer.on('upgrade', (req, socket) => {
    if (req.url !== '/bridge') {
      socket.destroy();
      return;
    }
    bridgeSocketRef = socket;
    if (!acceptWebSocketUpgrade(req, socket)) return;
    bridgeSocketReady.resolve(socket);

    attachWebSocketFrameParser(socket, (text) => {
      const message = JSON.parse(text) as
        | { type: 'pong'; timestamp: number }
        | { type: 'ws-open-result'; streamId: string; success: boolean }
        | { type: 'ws-frame'; streamId: string; dataBase64: string }
        | { type: 'ws-close'; streamId: string; code?: number; reason?: string };
      if (message.type === 'pong') {
        bridgePong.resolve();
        return;
      }
      if (message.type === 'ws-open-result' && message.success) {
        bridgeOpen.resolve();
        return;
      }
      if (message.type === 'ws-frame') {
        bridgeFrame.resolve(Buffer.from(message.dataBase64, 'base64').toString('utf8'));
        return;
      }
      if (message.type === 'ws-close') {
        bridgeClose.resolve({ code: message.code, reason: message.reason });
      }
    });

    socket.write(encodeTextFrame(JSON.stringify({ type: 'ping', timestamp: Date.now() })));
    socket.write(
      encodeTextFrame(
        JSON.stringify({
          type: 'ws-open',
          streamId: 'stream-1',
          path: '/echo',
          headers: {},
        }),
      ),
    );
  });
  cleanupTasks.push(() => closeLoopbackServer(bridgeServer));
  cleanupTasks.push(async () => {
    bridgeSocketRef?.destroy();
  });
  const bridgePort = await listenOnLoopback(bridgeServer);

  const { earlyExit } = startMetroCompanionWorker({
    bridgePort,
    localPort: upstreamPort,
  });

  const bridgeSocket = await Promise.race([
    waitFor(bridgeSocketReady.promise, 5_000, 'bridge websocket connection'),
    earlyExit,
  ]);
  assert.deepEqual(await waitFor(registrationBody.promise, 5_000, 'companion registration'), {
    tenantId: 'tenant-1',
    runId: 'run-1',
    leaseId: 'lease-1',
    local_base_url: `http://127.0.0.1:${upstreamPort}`,
  });
  await Promise.race([waitFor(bridgePong.promise, 5_000, 'bridge pong'), earlyExit]);
  await Promise.race([waitFor(bridgeOpen.promise, 5_000, 'bridge ws-open-result'), earlyExit]);
  bridgeSocket.write(
    encodeTextFrame(
      JSON.stringify({
        type: 'ws-frame',
        streamId: 'stream-1',
        dataBase64: Buffer.from('hello websocket', 'utf8').toString('base64'),
        binary: false,
      }),
    ),
  );
  await Promise.race([waitFor(upstreamMessage.promise, 5_000, 'upstream message'), earlyExit]);
  const echoedMessage = await Promise.race([
    waitFor(bridgeFrame.promise, 5_000, 'bridge echoed frame'),
    earlyExit,
  ]);
  bridgeSocket.write(
    encodeTextFrame(
      JSON.stringify({
        type: 'ws-close',
        streamId: 'stream-1',
        code: 1000,
        reason: 'bridge done',
      }),
    ),
  );
  const closeFrame = await Promise.race([
    waitFor(bridgeClose.promise, 5_000, 'bridge close frame'),
    earlyExit,
  ]);

  assert.equal(echoedMessage, 'hello websocket');
  assert.equal(closeFrame.code, 1000);
});

test('metro companion worker reconnects after the bridge closes immediately after open', async () => {
  const bridgeReconnect = createDeferred<void>();
  let bridgeConnections = 0;
  let bridgePort = 0;
  let bridgeSocketRef: Duplex | null = null;

  const localPort = await listenNotFoundServer();

  const bridgeServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/metro/companion/register') {
      req.resume();
      req.on('end', () => {
        writeSuccessfulRegistration(res, bridgePort);
      });
      return;
    }
    writeNotFound(res);
  });
  bridgeServer.on('upgrade', (req, socket) => {
    if (req.url !== '/bridge') {
      socket.destroy();
      return;
    }
    socket.on('error', () => {
      // The first bridge socket is expected to drop immediately to exercise reconnect handling.
    });
    if (!acceptWebSocketUpgrade(req, socket)) return;
    bridgeSocketRef = socket;
    bridgeConnections += 1;
    if (bridgeConnections === 1) {
      socket.end();
      return;
    }
    bridgeReconnect.resolve();
  });
  cleanupTasks.push(() => closeLoopbackServer(bridgeServer));
  cleanupTasks.push(async () => {
    bridgeSocketRef?.destroy();
  });
  const listenedBridgePort = await listenOnLoopback(bridgeServer);
  bridgePort = listenedBridgePort;

  const { earlyExit } = startMetroCompanionWorker({ bridgePort, localPort });

  await Promise.race([waitFor(bridgeReconnect.promise, 5_000, 'bridge reconnect'), earlyExit]);

  assert.equal(bridgeConnections, 2);
});

test('metro companion worker exits after non-retryable registration failure', async () => {
  let registerAttempts = 0;

  const localPort = await listenNotFoundServer();

  const bridgeServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/metro/companion/register') {
      registerAttempts += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
          }),
        );
      });
      return;
    }
    writeNotFound(res);
  });
  cleanupTasks.push(() => closeLoopbackServer(bridgeServer));
  const bridgePort = await listenOnLoopback(bridgeServer);

  const companion = startMetroCompanionWorker({
    bearerToken: 'bad-token',
    bridgePort,
    localPort,
  });
  const exit = await companion.waitForExit('worker exit after non-retryable registration failure');

  assert.equal(exit.signal, null, `unexpected worker stderr: ${companion.readStderr()}`);
  assert.equal(exit.code, 0, `unexpected worker stderr: ${companion.readStderr()}`);
  assert.equal(registerAttempts, 1);
});

test('metro companion worker retries registration failures with retry-after delay', async () => {
  const bridgeSocketReady = createDeferred<void>();
  const registerAttemptTimes: number[] = [];
  let bridgePort = 0;
  let bridgeSocketRef: Duplex | null = null;

  const localPort = await listenNotFoundServer();

  const bridgeServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/metro/companion/register') {
      registerAttemptTimes.push(Date.now());
      req.resume();
      req.on('end', () => {
        if (registerAttemptTimes.length === 1) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.05' });
          res.end(
            JSON.stringify({
              ok: false,
              error: { code: 'RATE_LIMITED', message: 'Try again later' },
            }),
          );
          return;
        }
        writeSuccessfulRegistration(res, bridgePort);
      });
      return;
    }
    writeNotFound(res);
  });
  bridgeServer.on('upgrade', (req, socket) => {
    if (req.url !== '/bridge') {
      socket.destroy();
      return;
    }
    bridgeSocketRef = socket;
    if (!acceptWebSocketUpgrade(req, socket)) return;
    bridgeSocketReady.resolve();
  });
  cleanupTasks.push(() => closeLoopbackServer(bridgeServer));
  cleanupTasks.push(async () => {
    bridgeSocketRef?.destroy();
  });
  bridgePort = await listenOnLoopback(bridgeServer);

  const { earlyExit } = startMetroCompanionWorker({ bridgePort, localPort });

  await Promise.race([
    waitFor(bridgeSocketReady.promise, 5_000, 'bridge websocket connection after retry'),
    earlyExit,
  ]);

  assert.equal(registerAttemptTimes.length, 2);
  assert.ok(registerAttemptTimes[1]! - registerAttemptTimes[0]! >= 40);
});

test('metro companion worker exits after its state file is removed', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-companion-worker-'));
  const statePath = path.join(tempRoot, 'metro-companion.json');
  fs.writeFileSync(statePath, '{}', 'utf8');
  cleanupTasks.push(async () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const bridgeSocketReady = createDeferred<void>();
  let unregisterRequests = 0;
  let bridgePort = 0;
  let bridgeSocketRef: Duplex | null = null;

  const localPort = await listenNotFoundServer();

  const bridgeServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/metro/companion/register') {
      req.resume();
      req.on('end', () => {
        writeSuccessfulRegistration(res, bridgePort);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/metro/companion/unregister') {
      unregisterRequests += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    writeNotFound(res);
  });
  bridgeServer.on('upgrade', (req, socket) => {
    if (req.url !== '/bridge') {
      socket.destroy();
      return;
    }
    bridgeSocketRef = socket;
    if (!acceptWebSocketUpgrade(req, socket)) return;
    bridgeSocketReady.resolve();
  });
  cleanupTasks.push(() => closeLoopbackServer(bridgeServer));
  cleanupTasks.push(async () => {
    bridgeSocketRef?.destroy();
  });
  bridgePort = await listenOnLoopback(bridgeServer);

  const companion = startMetroCompanionWorker({
    bridgePort,
    localPort,
    statePath,
    unregisterPath: '/api/metro/companion/unregister',
  });

  await waitFor(bridgeSocketReady.promise, 5_000, 'bridge websocket connection');
  fs.unlinkSync(statePath);
  (bridgeSocketRef as Duplex | null)?.destroy();

  const exit = await companion.waitForExit('worker exit after state cleanup');

  assert.equal(exit.signal, null, `unexpected worker stderr: ${companion.readStderr()}`);
  assert.equal(exit.code, 0, `unexpected worker stderr: ${companion.readStderr()}`);
  assert.equal(unregisterRequests, 1);
});

test('companion tunnel entrypoint reads neutral env and exits when state file is missing', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-companion-worker-'));
  const statePath = path.join(tempRoot, 'missing-metro-companion.json');
  cleanupTasks.push(async () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const companion = spawnMetroCompanionWorker({
    serverBaseUrl: 'http://127.0.0.1:1',
    localBaseUrl: 'http://127.0.0.1:1',
    statePath,
  });
  const exit = await companion.waitForExit('worker exit with missing state file');

  assert.equal(exit.signal, null, `unexpected worker stderr: ${companion.readStderr()}`);
  assert.equal(exit.code, 0, `unexpected worker stderr: ${companion.readStderr()}`);
});
