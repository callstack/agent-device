import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, test } from 'vitest';
import {
  buildCompanionPayload,
  runCompanionTunnelProcessFromEnv,
  runCompanionTunnelWorker,
} from './client-companion-tunnel-worker.ts';
import {
  METRO_COMPANION_RUN_ARG,
  MissingCompanionEnvError,
} from './client-companion-tunnel-contract.ts';
import {
  acceptWebSocketUpgrade,
  attachWebSocketFrameParser,
  companionEnv,
  createCompanionBridgeServer,
  encodeCloseFrame,
  encodeTextFrame,
  writeNotFound,
  writeSuccessfulRegistration,
  type CloseFrame,
} from './client-companion-tunnel-worker.fixtures.ts';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
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
      'packages/react-native/src/companion/companion-tunnel.ts',
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
  const tempRoot = mkdtempForTestSync('agent-device-metro-companion-worker-');
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

test('companion payload carries the bridge scope, local base URL, and launch URL', () => {
  assert.deepEqual(
    buildCompanionPayload({
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081/',
      bridgeScope: {
        tenantId: 'tenant-1',
        runId: 'run-1',
        leaseId: 'lease-1',
      },
      launchUrl: 'myapp://open',
      registerPath: '/api/metro/companion/register',
    }),
    {
      tenantId: 'tenant-1',
      runId: 'run-1',
      leaseId: 'lease-1',
      local_base_url: 'http://127.0.0.1:8081',
      launch_url: 'myapp://open',
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
  const tempRoot = mkdtempForTestSync('agent-device-metro-companion-worker-');
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
  const tempRoot = mkdtempForTestSync('agent-device-metro-companion-worker-');
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

test('companion tunnel entrypoint runs only for its own run args and refuses incomplete env', async () => {
  // The worker module is also loaded by unrelated entrypoints: it must decline, not throw.
  assert.equal(await runCompanionTunnelProcessFromEnv([], companionEnv()), false);
  assert.equal(await runCompanionTunnelProcessFromEnv(['--help'], companionEnv()), false);

  const requiredEnvKeys = [
    'AGENT_DEVICE_COMPANION_TUNNEL_SERVER_BASE_URL',
    'AGENT_DEVICE_COMPANION_TUNNEL_BEARER_TOKEN',
    'AGENT_DEVICE_COMPANION_TUNNEL_LOCAL_BASE_URL',
    'AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_TENANT_ID',
    'AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_RUN_ID',
    'AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_LEASE_ID',
    'AGENT_DEVICE_COMPANION_TUNNEL_REGISTER_PATH',
  ] as const;
  for (const key of requiredEnvKeys) {
    await assert.rejects(
      () =>
        runCompanionTunnelProcessFromEnv([METRO_COMPANION_RUN_ARG], companionEnv({ [key]: '  ' })),
      MissingCompanionEnvError,
      `expected blank ${key} to be refused`,
    );
  }
});

test('metro companion worker proxies bridge http requests to the local server', async () => {
  const requests = [
    { requestId: 'req-text', method: 'GET', path: '/text' },
    { requestId: 'req-empty', method: 'GET', path: '/empty' },
    {
      requestId: 'req-echo',
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'text/plain' },
      bodyBase64: Buffer.from('payload', 'utf8').toString('base64'),
    },
    // A local server that drops the connection: the bridge must see http-error, not a crash.
    { requestId: 'req-boom', method: 'GET', path: '/boom' },
  ];
  const answers = new Map<string, Deferred<Record<string, unknown>>>();
  for (const request of requests) {
    answers.set(request.requestId, createDeferred());
  }
  const bridgeSocketReady = createDeferred<Duplex>();
  let bridgeSocketRef: Duplex | null = null;

  const localServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-served-by': 'local' });
      res.end('hello local');
      return;
    }
    if (req.method === 'GET' && req.url === '/empty') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/echo') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`echoed:${Buffer.concat(chunks).toString('utf8')}`);
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/boom') {
      req.socket.destroy();
      return;
    }
    writeNotFound(res);
  });
  cleanupTasks.push(() => closeLoopbackServer(localServer));
  const localPort = await listenOnLoopback(localServer);

  const bridge = createCompanionBridgeServer();
  bridge.serveBridgeUpgrade((socket) => {
    bridgeSocketRef = socket;
    bridgeSocketReady.resolve(socket);
    attachWebSocketFrameParser(socket, (text) => {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (typeof message.requestId === 'string') {
        answers.get(message.requestId)?.resolve(message);
      }
    });
  });
  cleanupTasks.push(() => closeLoopbackServer(bridge.server));
  cleanupTasks.push(async () => {
    bridgeSocketRef?.destroy();
  });
  const bridgePort = await bridge.listen();

  const { earlyExit } = startMetroCompanionWorker({ bridgePort, localPort });
  const bridgeSocket = await Promise.race([
    waitFor(bridgeSocketReady.promise, 5_000, 'bridge websocket connection'),
    earlyExit,
  ]);
  for (const request of requests) {
    bridgeSocket.write(encodeTextFrame(JSON.stringify({ type: 'http-request', ...request })));
  }
  const answered = async (requestId: string) =>
    await Promise.race([
      waitFor(answers.get(requestId)!.promise, 5_000, `http response ${requestId}`),
      earlyExit,
    ]);
  const textResponse = await answered('req-text');
  const emptyResponse = await answered('req-empty');
  const echoResponse = await answered('req-echo');
  const errorResponse = await answered('req-boom');

  assert.equal(textResponse.type, 'http-response');
  assert.equal(textResponse.status, 200);
  assert.equal(
    (textResponse.headers as Record<string, string>)['x-served-by'],
    'local',
    `bridge headers: ${JSON.stringify(textResponse.headers)}`,
  );
  assert.equal(
    Buffer.from(String(textResponse.bodyBase64), 'base64').toString('utf8'),
    'hello local',
  );
  // An empty local body must not be answered as a base64 payload.
  assert.equal(emptyResponse.type, 'http-response');
  assert.equal(emptyResponse.status, 204);
  assert.equal('bodyBase64' in emptyResponse, false);
  // A request body crosses as base64 and comes back from the local server intact.
  assert.equal(echoResponse.status, 200);
  assert.equal(
    Buffer.from(String(echoResponse.bodyBase64), 'base64').toString('utf8'),
    'echoed:payload',
  );
  assert.equal(errorResponse.type, 'http-error');
  assert.equal(errorResponse.requestId, 'req-boom');
  assert.ok(String(errorResponse.message).length > 0);
});

test('metro companion worker normalizes close codes the websocket client cannot send', async () => {
  // A WebSocket client may only close with 1000 or 3000-4999. Every other bridge code must reach
  // upstream as 3001 instead of throwing inside the worker and stranding the tunnel.
  //
  // The codes are asserted per stream, not as a sorted multiset, so each expected wire code is
  // pinned to the bridge code that produced it. `stream-fractional` is what makes the first
  // normalization stage observable: the second stage passes any 3000-4999 value through, so
  // without the non-integer rejection here the 3500.5 would reach the wire truncated to 3500
  // instead of being refused as 3001.
  const closeCodes: Record<string, number | undefined> = {
    'stream-1000': 1000,
    'stream-4000': 4000,
    'stream-1005': 1005,
    'stream-1001': 1001,
    'stream-none': undefined,
    'stream-fractional': 3500.5,
  };
  const expectedCloses: Record<string, CloseFrame> = {
    'stream-1000': { code: 1000, reason: 'bridge done' },
    'stream-4000': { code: 4000, reason: 'bridge requested close' },
    'stream-1005': { code: 3001, reason: 'bridge requested close' },
    'stream-1001': { code: 3001, reason: 'bridge requested close' },
    'stream-none': { code: 3001, reason: 'bridge requested close' },
    'stream-fractional': { code: 3001, reason: 'bridge requested close' },
  };
  const streamIds = Object.keys(closeCodes);
  const upstreamCloses = new Map<string, CloseFrame>();
  const upstreamClosed = createDeferred<void>();
  let upstreamSocketRef: Duplex | null = null;

  const upstreamServer = http.createServer((_, res) => writeNotFound(res));
  upstreamServer.on('upgrade', (req, socket) => {
    const streamId = req.url?.startsWith('/echo/') ? req.url.slice('/echo/'.length) : undefined;
    if (!streamId || !(streamId in closeCodes)) {
      socket.destroy();
      return;
    }
    upstreamSocketRef = socket;
    if (!acceptWebSocketUpgrade(req, socket)) return;
    attachWebSocketFrameParser(
      socket,
      () => {
        // This probe only answers close frames; text frames are not proxied here.
      },
      (frame) => {
        upstreamCloses.set(streamId, frame);
        if (upstreamCloses.size === streamIds.length) upstreamClosed.resolve();
      },
    );
  });
  cleanupTasks.push(() => closeLoopbackServer(upstreamServer));
  cleanupTasks.push(async () => {
    upstreamSocketRef?.destroy();
  });
  const upstreamPort = await listenOnLoopback(upstreamServer);

  const bridgeSocketReady = createDeferred<Duplex>();
  const pongs = createDeferred<void>();
  let pongCount = 0;
  let bridgeSocketRef: Duplex | null = null;
  const bridge = createCompanionBridgeServer();
  bridge.serveBridgeUpgrade((socket) => {
    bridgeSocketRef = socket;
    bridgeSocketReady.resolve(socket);
    const opened = new Set<string>();
    attachWebSocketFrameParser(socket, (text) => {
      const message = JSON.parse(text) as
        | { type: 'pong' }
        | { type: 'ws-open-result'; streamId: string; success: boolean };
      if (message.type === 'pong') {
        pongCount += 1;
        if (pongCount === 2) pongs.resolve();
        return;
      }
      if (message.type !== 'ws-open-result' || !message.success) return;
      opened.add(message.streamId);
      if (opened.size !== streamIds.length) return;
      for (const streamId of streamIds) {
        const code = closeCodes[streamId];
        socket.write(
          encodeTextFrame(
            JSON.stringify({
              type: 'ws-close',
              streamId,
              ...(code === undefined ? {} : { code }),
              ...(streamId === 'stream-1000' ? { reason: 'bridge done' } : {}),
            }),
          ),
        );
      }
      socket.write(encodeTextFrame(JSON.stringify({ type: 'ping', timestamp: Date.now() })));
    });
    for (const streamId of streamIds) {
      socket.write(
        encodeTextFrame(
          JSON.stringify({ type: 'ws-open', streamId, path: `/echo/${streamId}`, headers: {} }),
        ),
      );
    }
  });
  cleanupTasks.push(() => closeLoopbackServer(bridge.server));
  cleanupTasks.push(async () => {
    bridgeSocketRef?.destroy();
  });
  const bridgePort = await bridge.listen();

  const { earlyExit } = startMetroCompanionWorker({ bridgePort, localPort: upstreamPort });
  await Promise.race([
    waitFor(upstreamClosed.promise, 5_000, 'every upstream close frame'),
    earlyExit,
  ]);

  const expectedByStream = streamIds.map((streamId) => ({
    streamId,
    received: upstreamCloses.get(streamId),
    expected: expectedCloses[streamId],
  }));
  assert.deepEqual(
    expectedByStream.map((entry) => [entry.streamId, entry.received]),
    expectedByStream.map((entry) => [entry.streamId, entry.expected]),
  );

  // The worker keeps serving after the normalized closes.
  const bridgeSocket = await bridgeSocketReady.promise;
  bridgeSocket.write(encodeTextFrame(JSON.stringify({ type: 'ping', timestamp: Date.now() })));
  await Promise.race([waitFor(pongs.promise, 5_000, 'two bridge pongs'), earlyExit]);
});
