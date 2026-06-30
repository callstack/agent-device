import { test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeLoopbackServer,
  listenOnLoopback,
  supportsLoopbackBind,
} from '../../__tests__/test-utils/index.ts';
import { runCmdBackground } from '../exec.ts';
import {
  canConnectSocket,
  cleanupFailedDaemonStartupMetadata,
  computeDaemonCodeSignature,
  downloadRemoteArtifact,
  resolveDaemonRequestTimeoutMs,
  resolveDaemonStartupHint,
  sendToDaemon,
  shouldResetDaemonAfterRequestTimeout,
} from '../../daemon/client/daemon-client.ts';
import { resolveDaemonPaths } from '../../daemon/config.ts';
import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  stopProcessForTakeover,
  waitForProcessExit,
} from '../process-identity.ts';
import { findProjectRoot, readVersion } from '../version.ts';

type MockHttpResponse = EventEmitter & {
  headers?: Record<string, string>;
  statusCode?: number;
  resume: () => void;
  setEncoding: (_encoding: string) => void;
};

async function withRemoteDaemonEnv<T>(callback: () => Promise<T>): Promise<T> {
  const previousBaseUrl = process.env.AGENT_DEVICE_DAEMON_BASE_URL;
  const previousAuthToken = process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  process.env.AGENT_DEVICE_DAEMON_BASE_URL = 'http://remote-mac.example.test:7777/agent-device';
  process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = 'remote-secret';

  try {
    return await callback();
  } finally {
    if (previousBaseUrl === undefined) delete process.env.AGENT_DEVICE_DAEMON_BASE_URL;
    else process.env.AGENT_DEVICE_DAEMON_BASE_URL = previousBaseUrl;
    if (previousAuthToken === undefined) delete process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
    else process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = previousAuthToken;
  }
}

function emitJsonRpcResult(res: MockHttpResponse, id: string, result: unknown): void {
  res.emit('data', JSON.stringify({ jsonrpc: '2.0', id, result }));
  res.emit('end');
}

function mockEventHttpRequest(
  handler: (context: { options: Record<string, any>; body: string; res: MockHttpResponse }) => void,
): () => void {
  const originalHttpRequest = http.request;
  (http as unknown as { request: typeof http.request }).request = ((
    options: any,
    callback: (res: any) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => void;
      end: () => void;
      destroy: () => void;
    };
    let body = '';
    req.write = (chunk: string) => {
      body += chunk;
    };
    req.destroy = () => {
      req.emit('close');
    };
    req.end = () => {
      const res = new EventEmitter() as MockHttpResponse;
      res.statusCode = 200;
      res.resume = () => {};
      res.setEncoding = () => {};
      process.nextTick(() => {
        callback(res);
        handler({ options, body, res });
      });
    };
    return req as any;
  }) as typeof http.request;

  return () => {
    (http as unknown as { request: typeof http.request }).request = originalHttpRequest;
  };
}

async function captureInteractiveStderr(callback: () => Promise<void>): Promise<string> {
  const stderr = process.stderr as typeof process.stderr & { isTTY?: boolean };
  const mutableStderr = stderr as unknown as Record<string, unknown>;
  const originalIsTTY = Object.getOwnPropertyDescriptor(stderr, 'isTTY');
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalCi = process.env.CI;
  let output = '';
  Object.defineProperty(stderr, 'isTTY', { configurable: true, value: true });
  delete process.env.CI;
  (process.stderr as any).write = ((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await callback();
    return output;
  } finally {
    process.stderr.write = originalWrite;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    if (originalIsTTY) Object.defineProperty(stderr, 'isTTY', originalIsTTY);
    else delete mutableStderr.isTTY;
  }
}

function respondToHealthcheck(options: Record<string, any>, res: MockHttpResponse): boolean {
  if (options.method !== 'GET') return false;
  res.emit('end');
  return true;
}

function resolveCurrentDaemonCodeSignature(): string {
  const root = findProjectRoot();
  const distPath = path.join(root, 'dist', 'src', 'internal', 'daemon.js');
  const sourcePath = path.join(root, 'src', 'daemon.ts');
  const entryPath =
    process.execArgv.includes('--experimental-strip-types') || !fs.existsSync(distPath)
      ? sourcePath
      : distPath;
  return computeDaemonCodeSignature(entryPath, root);
}

function writeCurrentDaemonInfo(
  stateDir: string,
  info: { port?: number; httpPort?: number; transport: 'socket' | 'http' | 'dual' },
): void {
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    `${JSON.stringify({
      ...info,
      token: 'local-secret',
      pid: process.pid,
      version: readVersion(),
      codeSignature: resolveCurrentDaemonCodeSignature(),
      processStartTime: readProcessStartTime(process.pid) ?? undefined,
    })}\n`,
    'utf8',
  );
}

test('resolveDaemonStartupHint prefers stale lock guidance when lock exists without info', () => {
  const hint = resolveDaemonStartupHint({ hasInfo: false, hasLock: true });
  assert.match(hint, /daemon\.lock/i);
  assert.match(hint, /automatically/i);
  assert.match(hint, /rm -f '.+daemon\.json' '.+daemon\.lock'/);
});

test('resolveDaemonStartupHint covers stale info+lock pair', () => {
  const hint = resolveDaemonStartupHint({ hasInfo: true, hasLock: true });
  assert.match(hint, /daemon\.json/i);
  assert.match(hint, /daemon\.lock/i);
  assert.match(hint, /rm -f '.+daemon\.json' '.+daemon\.lock'/);
});

test('resolveDaemonStartupHint falls back to daemon.json guidance', () => {
  const hint = resolveDaemonStartupHint({ hasInfo: true, hasLock: false });
  assert.match(hint, /daemon\.json/i);
  assert.match(hint, /rm -f '.+daemon\.json' '.+daemon\.lock'/);
});

test('resolveDaemonStartupHint includes configured state directory paths', () => {
  const paths = resolveDaemonPaths('/tmp/ad-custom-state');
  const hint = resolveDaemonStartupHint({ hasInfo: false, hasLock: true }, paths);
  assert.match(hint, /\/tmp\/ad-custom-state\/daemon\.lock/);
  assert.match(hint, /\/tmp\/ad-custom-state\/daemon\.json/);
  assert.match(
    hint,
    /rm -f '\/tmp\/ad-custom-state\/daemon\.json' '\/tmp\/ad-custom-state\/daemon\.lock'/,
  );
});

test('resolveDaemonStartupHint shell-quotes cleanup paths', () => {
  const paths = resolveDaemonPaths("/tmp/ad custom's state");
  const hint = resolveDaemonStartupHint({ hasInfo: true, hasLock: true }, paths);
  assert.match(
    hint,
    /rm -f '\/tmp\/ad custom'\\''s state\/daemon\.json' '\/tmp\/ad custom'\\''s state\/daemon\.lock'/,
  );
});

test('snapshot request timeout preserves daemon metadata for follow-up evidence commands', () => {
  assert.equal(shouldResetDaemonAfterRequestTimeout('snapshot'), false);
  assert.equal(shouldResetDaemonAfterRequestTimeout('screenshot'), true);
  assert.equal(shouldResetDaemonAfterRequestTimeout(undefined), true);
});

test('snapshot uses the standard daemon request timeout with an explicit override', () => {
  const base = {
    session: 'default',
    positionals: [],
    flags: {},
    meta: {},
  };

  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'snapshot' }), 90_000);
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'snapshot',
      flags: { timeoutMs: 120_000 },
    }),
    120_000,
  );
  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'screenshot' }), 90_000);
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'prepare',
      positionals: ['ios-runner'],
    }),
    240_000,
  );
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'prepare',
      positionals: ['ios-runner'],
      flags: { timeoutMs: 240_000 },
    }),
    240_000,
  );
  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'test' }), undefined);
});

test('cleanupFailedDaemonStartupMetadata removes partial startup metadata', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-cleanup-'));
  const paths = resolveDaemonPaths(stateDir);
  try {
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(paths.infoPath, '{"invalid":true}\n', 'utf8');
    fs.writeFileSync(paths.lockPath, 'not-json\n', 'utf8');

    const result = await cleanupFailedDaemonStartupMetadata(paths, 'startup_timeout');

    assert.deepEqual(result, {
      reason: 'startup_timeout',
      removedInfo: true,
      removedLock: true,
      stoppedInfoProcess: false,
      stoppedLockProcess: false,
    });
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cleanupFailedDaemonStartupMetadata retains live startup daemon on timeout', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-live-cleanup-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-live-daemon-'));
  const daemonDir = path.join(root, 'agent-device', 'dist', 'src', 'internal');
  const daemonScriptPath = path.join(daemonDir, 'daemon.js');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(daemonScriptPath, 'setInterval(() => {}, 1000);\n', 'utf8');
  const daemonProcess = runCmdBackground(process.execPath, [daemonScriptPath], {
    stdio: 'ignore',
    allowFailure: true,
    captureOutput: false,
  });
  void daemonProcess.wait.catch(() => {});
  const pid = daemonProcess.child.pid;
  assert.ok(pid, 'spawned child should have a pid');

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const processStartTime = readProcessStartTime(pid) ?? undefined;
    if (readProcessCommand(pid) === null || processStartTime === undefined) {
      t.skip('process command/start inspection is unavailable in this environment');
      return;
    }

    const paths = resolveDaemonPaths(stateDir);
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(
      paths.infoPath,
      `${JSON.stringify({
        token: 'startup-secret',
        port: 65530,
        transport: 'socket',
        pid,
        processStartTime,
      })}\n`,
      'utf8',
    );
    fs.writeFileSync(
      paths.lockPath,
      `${JSON.stringify({ pid, processStartTime, startedAt: Date.now() })}\n`,
      'utf8',
    );

    const result = await cleanupFailedDaemonStartupMetadata(paths, 'startup_timeout', {
      stopLiveProcesses: false,
    });

    assert.equal(result.retainedInfoProcess, true);
    assert.equal(result.retainedLockProcess, true);
    assert.equal(result.removedInfo, false);
    assert.equal(result.removedLock, false);
    assert.equal(isProcessAlive(pid), true);
    assert.equal(fs.existsSync(paths.infoPath), true);
    assert.equal(fs.existsSync(paths.lockPath), true);
  } finally {
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
      await waitForProcessExit(pid, 1_500);
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanupFailedDaemonStartupMetadata removes stale daemon metadata on timeout', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-stale-cleanup-'));
  const paths = resolveDaemonPaths(stateDir);
  try {
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(
      paths.infoPath,
      `${JSON.stringify({
        token: 'startup-secret',
        port: 65530,
        transport: 'socket',
        pid: 999_999,
      })}\n`,
      'utf8',
    );
    fs.writeFileSync(
      paths.lockPath,
      `${JSON.stringify({ pid: 999_999, startedAt: Date.now() })}\n`,
      'utf8',
    );

    const result = await cleanupFailedDaemonStartupMetadata(paths, 'startup_timeout', {
      stopLiveProcesses: false,
    });

    assert.equal(result.removedInfo, true);
    assert.equal(result.removedLock, true);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('canConnectSocket times out stalled local daemon probes', async () => {
  const originalCreateConnection = net.createConnection;
  let timeoutMs: number | undefined;
  let destroyed = false;
  const socket = new EventEmitter() as EventEmitter & {
    destroy: () => void;
    setTimeout: (ms: number) => typeof socket;
  };
  socket.destroy = () => {
    destroyed = true;
  };
  socket.setTimeout = (ms: number) => {
    timeoutMs = ms;
    setImmediate(() => socket.emit('timeout'));
    return socket;
  };

  (net as unknown as { createConnection: typeof net.createConnection }).createConnection = ((
    _options: unknown,
    _listener?: () => void,
  ) => socket) as typeof net.createConnection;

  try {
    const reachable = await canConnectSocket(65_530);

    assert.equal(reachable, false);
    assert.equal(timeoutMs, 500);
    assert.equal(destroyed, true);
  } finally {
    (net as unknown as { createConnection: typeof net.createConnection }).createConnection =
      originalCreateConnection;
  }
});

test('sendToDaemon reuses reachable local socket daemon metadata', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-local-socket-daemon-'));
  let requestBody = '';
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      requestBody += chunk;
      if (!requestBody.includes('\n')) return;
      const request = JSON.parse(requestBody.trim()) as Record<string, any>;
      assert.equal(request.command, 'local-socket-smoke');
      assert.equal(request.token, 'local-secret');
      assert.equal(request.meta?.requestId, 'req-local-socket');
      socket.end(`${JSON.stringify({ ok: true, data: { via: 'socket' } })}\n`);
    });
  });

  try {
    const port = await listenOnLoopback(server);
    writeCurrentDaemonInfo(stateDir, { port, transport: 'socket' });

    const response = await sendToDaemon({
      session: 'default',
      command: 'local-socket-smoke',
      positionals: ['ping'],
      flags: { stateDir, daemonTransport: 'socket' },
      meta: { requestId: 'req-local-socket' },
    });

    assert.deepEqual(response, { ok: true, data: { via: 'socket' } });
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sendToDaemon prints replay test progress before the socket response', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-socket-progress-'));
  const artifactsDir = path.join(stateDir, 'login-flow');
  const attemptDir = path.join(artifactsDir, 'attempt-2');
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(
    path.join(attemptDir, 'replay-timing.ndjson'),
    [
      {
        type: 'replay_action_start',
        step: 1,
        line: 3,
        command: 'open',
        positionals: ['Demo'],
      },
      {
        type: 'replay_action_stop',
        step: 1,
        line: 3,
        command: 'open',
        ok: true,
        durationMs: 250,
      },
      {
        type: 'replay_action_start',
        step: 2,
        line: 4,
        command: '__maestroAssertVisible',
        positionals: ['text="Home"', '3000'],
      },
      {
        type: 'replay_action_stop',
        step: 2,
        line: 4,
        command: '__maestroAssertVisible',
        ok: true,
        durationMs: 750,
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );
  let stderr = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalCreateConnection = net.createConnection;
  let createConnectionCalls = 0;
  (net as unknown as { createConnection: typeof net.createConnection }).createConnection = ((
    _options: unknown,
    connectListener?: () => void,
  ) => {
    createConnectionCalls += 1;
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      end: () => void;
      setEncoding: () => void;
      setTimeout: () => void;
      write: (_chunk: string) => boolean;
    };
    socket.destroy = () => {
      socket.emit('close');
    };
    socket.end = () => {
      socket.emit('close');
    };
    socket.setEncoding = () => {};
    socket.setTimeout = () => {};
    socket.write = () => {
      if (createConnectionCalls === 2) {
        process.nextTick(() => {
          const progress = `${JSON.stringify({
            type: 'progress',
            event: {
              type: 'replay-test',
              file: '/tmp/01-login.ad',
              title: 'Login flow',
              status: 'pass',
              index: 1,
              total: 2,
              attempt: 2,
              maxAttempts: 2,
              durationMs: 1234,
              artifactsDir,
            },
          })}\n`;
          socket.emit('data', progress);
          socket.emit('data', progress);
          socket.emit(
            'data',
            `${JSON.stringify({
              type: 'response',
              response: { ok: true, data: { via: 'socket' } },
            })}\n`,
          );
        });
      }
      return true;
    };
    process.nextTick(() => connectListener?.());
    return socket as unknown as net.Socket;
  }) as typeof net.createConnection;

  try {
    (process.stderr as any).write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    writeCurrentDaemonInfo(stateDir, { port: 65_530, transport: 'socket' });

    const response = await sendToDaemon({
      session: 'default',
      command: 'test',
      positionals: ['/tmp/replays'],
      flags: { stateDir, daemonTransport: 'socket', verbose: true },
      meta: { requestId: 'req-progress', requestProgress: 'replay-test' },
    });

    assert.deepEqual(response, { ok: true, data: { via: 'socket' } });
    assert.match(stderr, /✓ Login flow 1\.23s/);
    assert.equal(stderr.match(/✓ Login flow 1\.23s/g)?.length, 1);
    assert.match(stderr, /steps \(attempt 2\):/);
    assert.match(stderr, /open "Demo" \(line 3, 0\.25s\)/);
    assert.match(stderr, /assertVisible "text=\\"Home\\"" "3000" \(line 4, 0\.75s\)/);
  } finally {
    (net as unknown as { createConnection: typeof net.createConnection }).createConnection =
      originalCreateConnection;
    process.stderr.write = originalStderrWrite;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sendToDaemon prints replay test progress before the HTTP NDJSON response', async () => {
  let stderr = '';
  const seenPaths: string[] = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalHttpRequest = http.request;
  (http as unknown as { request: typeof http.request }).request = ((
    options: any,
    callback: (res: any) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => void;
      end: () => void;
      destroy: () => void;
    };
    let body = '';
    req.write = (chunk: string) => {
      body += chunk;
    };
    req.destroy = () => {
      req.emit('close');
    };
    req.end = () => {
      seenPaths.push(`${String(options.method ?? 'GET')} ${String(options.path ?? '')}`);
      const res = new EventEmitter() as MockHttpResponse;
      res.statusCode = 200;
      res.resume = () => {};
      res.setEncoding = () => {};
      if (options.method === 'GET') {
        process.nextTick(() => {
          callback(res);
          res.emit('end');
        });
        return;
      }

      const rpcRequest = JSON.parse(body) as { id?: string };
      res.headers = { 'content-type': 'application/x-ndjson' };
      process.nextTick(() => {
        callback(res);
        res.emit(
          'data',
          `${JSON.stringify({
            type: 'progress',
            event: {
              type: 'replay-test',
              file: '/tmp/02-payments.ad',
              title: 'Payments flow',
              status: 'pass',
              index: 2,
              total: 3,
              attempt: 1,
              maxAttempts: 1,
              durationMs: 2500,
            },
          })}\n`,
        );
        res.emit(
          'data',
          `${JSON.stringify({
            type: 'response',
            response: {
              jsonrpc: '2.0',
              id: rpcRequest.id,
              result: { ok: true, data: { via: 'http-progress' } },
            },
          })}\n`,
        );
        res.emit('data', '{not-json-after-settle}\n');
        res.emit('end');
      });
    };
    return req as any;
  }) as typeof http.request;

  try {
    (process.stderr as any).write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    await withRemoteDaemonEnv(async () => {
      const response = await sendToDaemon({
        session: 'default',
        command: 'test',
        positionals: ['/tmp/replays'],
        flags: {},
        meta: { requestId: 'req-http-progress', requestProgress: 'replay-test' },
      });

      assert.deepEqual(response, { ok: true, data: { via: 'http-progress' } });
    });
    assert.deepEqual(seenPaths, ['GET /agent-device/health', 'POST /agent-device/rpc']);
    assert.match(stderr, /✓ Payments flow 2\.50s/);
  } finally {
    (http as unknown as { request: typeof http.request }).request = originalHttpRequest;
    process.stderr.write = originalStderrWrite;
  }
});

test('sendToDaemon reuses reachable local HTTP daemon metadata with token params', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-local-http-daemon-'));
  const seenPaths: string[] = [];
  const observed: { rpcRequest?: Record<string, any> } = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    seenPaths.push(`${req.method ?? 'GET'} ${url.pathname}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        observed.rpcRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          any
        >;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: observed.rpcRequest.id,
            result: { ok: true, data: { via: 'http' } },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  try {
    const httpPort = await listenOnLoopback(server);
    writeCurrentDaemonInfo(stateDir, { httpPort, transport: 'http' });

    const response = await sendToDaemon({
      session: 'default',
      command: 'local-http-smoke',
      positionals: ['ping'],
      flags: { stateDir, daemonTransport: 'http' },
      meta: { requestId: 'req-local-http' },
    });

    assert.deepEqual(response, { ok: true, data: { via: 'http' } });
    assert.deepEqual(seenPaths, ['GET /health', 'POST /rpc']);
    const request = observed.rpcRequest;
    if (!request) {
      throw new Error('Expected local HTTP daemon RPC request.');
    }
    assert.equal(request.method, 'agent_device.command');
    assert.equal(request.params?.command, 'local-http-smoke');
    assert.equal(request.params?.token, 'local-secret');
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sendToDaemon uses explicit remote daemon base URL and auth token', async () => {
  let authHeader = '';
  let tokenHeader = '';
  let rpcRequest: Record<string, unknown> | null = null;
  const seenPaths: string[] = [];
  let healthcheckTimeout: number | undefined;
  const originalHttpRequest = http.request;
  (http as unknown as { request: typeof http.request }).request = ((
    options: any,
    callback: (res: any) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => void;
      end: () => void;
      destroy: () => void;
    };
    let body = '';
    req.write = (chunk: string) => {
      body += chunk;
    };
    req.destroy = () => {
      req.emit('close');
    };
    req.end = () => {
      seenPaths.push(String(options.path ?? ''));
      if (options.method === 'GET') {
        healthcheckTimeout = Number(options.timeout);
        const res = new EventEmitter() as EventEmitter & {
          statusCode?: number;
          resume: () => void;
          setEncoding: (_encoding: string) => void;
        };
        res.statusCode = 200;
        res.resume = () => {};
        res.setEncoding = () => {};
        process.nextTick(() => {
          callback(res);
          res.emit('end');
        });
        return;
      }

      authHeader = String(options.headers?.authorization ?? '');
      tokenHeader = String(options.headers?.['x-agent-device-token'] ?? '');
      rpcRequest = JSON.parse(body) as Record<string, unknown>;
      const res = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        setEncoding: (_encoding: string) => void;
      };
      res.statusCode = 200;
      res.setEncoding = () => {};
      process.nextTick(() => {
        callback(res);
        res.emit(
          'data',
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'req-remote',
            result: {
              ok: true,
              data: { source: 'remote-daemon' },
            },
          }),
        );
        res.emit('end');
      });
    };
    return req as any;
  }) as typeof http.request;

  const previousBaseUrl = process.env.AGENT_DEVICE_DAEMON_BASE_URL;
  const previousAuthToken = process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  process.env.AGENT_DEVICE_DAEMON_BASE_URL = 'http://remote-mac.example.test:7777/agent-device';
  process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = 'remote-secret';

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'remote-smoke',
      positionals: ['ping'],
      flags: {},
      meta: { requestId: 'req-remote' },
    });

    assert.equal(response.ok, true);
    assert.deepEqual(response.data, { source: 'remote-daemon' });
    assert.deepEqual(seenPaths, ['/agent-device/health', '/agent-device/rpc']);
    assert.equal(healthcheckTimeout, 3000);
    assert.equal(authHeader, 'Bearer remote-secret');
    assert.equal(tokenHeader, 'remote-secret');
    assert.equal((rpcRequest as any)?.method, 'agent_device.command');
    assert.equal((rpcRequest as any)?.params?.command, 'remote-smoke');
    assert.deepEqual((rpcRequest as any)?.params?.positionals, ['ping']);
    assert.equal((rpcRequest as any)?.params?.token, 'remote-secret');
  } finally {
    (http as unknown as { request: typeof http.request }).request = originalHttpRequest;
    if (previousBaseUrl === undefined) delete process.env.AGENT_DEVICE_DAEMON_BASE_URL;
    else process.env.AGENT_DEVICE_DAEMON_BASE_URL = previousBaseUrl;
    if (previousAuthToken === undefined) delete process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
    else process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = previousAuthToken;
  }
});

test('sendToDaemon rejects remote daemon RPC protocol mismatches before RPC', async () => {
  const seenPaths: string[] = [];
  let rpcCalled = false;
  const restoreHttpRequest = mockEventHttpRequest(({ options, res }) => {
    seenPaths.push(String(options.path ?? ''));
    if (options.method === 'GET') {
      res.emit(
        'data',
        JSON.stringify({
          ok: true,
          service: 'agent-device-proxy',
          version: '99.0.0',
          rpcProtocolVersion: 999,
        }),
      );
      res.emit('end');
      return;
    }

    rpcCalled = true;
    emitJsonRpcResult(res, 'req-incompatible', { ok: true, data: {} });
  });

  try {
    await withRemoteDaemonEnv(async () => {
      let error: unknown;
      try {
        await sendToDaemon({
          session: 'default',
          command: 'remote-smoke',
          positionals: ['ping'],
          flags: {},
          meta: { requestId: 'req-incompatible' },
        });
      } catch (caught) {
        error = caught;
      }

      assert.ok(error instanceof Error);
      assert.equal((error as any).code, 'COMMAND_FAILED');
      assert.match(error.message, /Remote daemon RPC protocol is incompatible/);
      assert.equal((error as any).details?.remoteService, 'agent-device-proxy');
      assert.equal((error as any).details?.remoteVersion, '99.0.0');
      assert.equal((error as any).details?.remoteRpcProtocolVersion, 999);
      assert.equal(typeof (error as any).details?.supportedRpcProtocolVersion, 'number');
    });

    assert.deepEqual(seenPaths, ['/agent-device/health']);
    assert.equal(rpcCalled, false);
  } finally {
    restoreHttpRequest();
  }
});

test('sendToDaemon hints to disconnect when a remote daemon is unavailable', async () => {
  const restoreHttpRequest = mockEventHttpRequest(({ res }) => {
    res.statusCode = 503;
    res.emit('end');
  });

  try {
    await withRemoteDaemonEnv(async () => {
      let error: unknown;
      try {
        await sendToDaemon({
          session: 'default',
          command: 'session',
          positionals: ['list'],
          flags: {},
          meta: { requestId: 'req-remote-unavailable' },
        });
      } catch (caught) {
        error = caught;
      }

      assert.ok(error instanceof Error);
      assert.equal((error as any).code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Remote daemon is unavailable');
      assert.match(String((error as any).details?.hint ?? ''), /agent-device disconnect/);
    });
  } finally {
    restoreHttpRequest();
  }
});

test('sendToDaemon sends lease helpers as top-level JSON-RPC methods over HTTP', async () => {
  const rpcRequests: Record<string, unknown>[] = [];
  const originalHttpRequest = http.request;
  (http as unknown as { request: typeof http.request }).request = ((
    options: any,
    callback: (res: any) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => void;
      end: () => void;
      destroy: () => void;
    };
    let body = '';
    req.write = (chunk: string) => {
      body += chunk;
    };
    req.destroy = () => {
      req.emit('close');
    };
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        resume: () => void;
        setEncoding: (_encoding: string) => void;
      };
      res.statusCode = 200;
      res.resume = () => {};
      res.setEncoding = () => {};
      process.nextTick(() => {
        callback(res);
        if (options.method === 'GET') {
          res.emit('end');
          return;
        }
        const rpcRequest = JSON.parse(body) as Record<string, any>;
        rpcRequests.push(rpcRequest);
        res.emit(
          'data',
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpcRequest.id,
            result: {
              ok: true,
              data: {
                lease:
                  rpcRequest.method === 'agent_device.lease.release'
                    ? undefined
                    : {
                        leaseId: 'lease-new',
                        tenantId: rpcRequest.params?.tenantId,
                        runId: rpcRequest.params?.runId,
                        backend: rpcRequest.params?.backend,
                      },
                released: rpcRequest.method === 'agent_device.lease.release' ? true : undefined,
              },
            },
          }),
        );
        res.emit('end');
      });
    };
    return req as any;
  }) as typeof http.request;

  const previousBaseUrl = process.env.AGENT_DEVICE_DAEMON_BASE_URL;
  const previousAuthToken = process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  process.env.AGENT_DEVICE_DAEMON_BASE_URL = 'http://remote-mac.example.test:7777/agent-device';
  process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = 'remote-secret';

  try {
    const allocateResponse = await sendToDaemon({
      session: 'qa-android',
      command: 'lease_allocate',
      positionals: [],
      flags: {},
      meta: {
        requestId: 'lease-req',
        tenantId: 'acme',
        runId: 'run-123',
        leaseBackend: 'android-instance',
        leaseTtlMs: 30_000,
      },
    });
    const heartbeatResponse = await sendToDaemon({
      session: 'qa-android',
      command: 'lease_heartbeat',
      positionals: [],
      flags: {},
      meta: {
        requestId: 'heartbeat-req',
        tenantId: 'acme',
        runId: 'run-123',
        leaseId: 'lease-new',
        leaseTtlMs: 15_000,
      },
    });
    const releaseResponse = await sendToDaemon({
      session: 'qa-android',
      command: 'lease_release',
      positionals: [],
      flags: {},
      meta: {
        requestId: 'release-req',
        tenantId: 'acme',
        runId: 'run-123',
        leaseId: 'lease-new',
      },
    });

    assert.equal(allocateResponse.ok, true);
    assert.equal(heartbeatResponse.ok, true);
    assert.equal(releaseResponse.ok, true);
    assert.equal(rpcRequests.length, 3);
    assert.equal(rpcRequests[0]?.method, 'agent_device.lease.allocate');
    assert.deepEqual(rpcRequests[0]?.params, {
      session: 'qa-android',
      tenantId: 'acme',
      runId: 'run-123',
      ttlMs: 30_000,
      backend: 'android-instance',
    });
    assert.equal(rpcRequests[1]?.method, 'agent_device.lease.heartbeat');
    assert.deepEqual(rpcRequests[1]?.params, {
      session: 'qa-android',
      tenantId: 'acme',
      runId: 'run-123',
      leaseId: 'lease-new',
      ttlMs: 15_000,
    });
    assert.equal(rpcRequests[2]?.method, 'agent_device.lease.release');
    assert.deepEqual(rpcRequests[2]?.params, {
      session: 'qa-android',
      tenantId: 'acme',
      runId: 'run-123',
      leaseId: 'lease-new',
    });
  } finally {
    (http as unknown as { request: typeof http.request }).request = originalHttpRequest;
    if (previousBaseUrl === undefined) delete process.env.AGENT_DEVICE_DAEMON_BASE_URL;
    else process.env.AGENT_DEVICE_DAEMON_BASE_URL = previousBaseUrl;
    if (previousAuthToken === undefined) delete process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
    else process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = previousAuthToken;
  }
});

test('sendToDaemon rejects socket transport when remote daemon base URL is set', async () => {
  const previousBaseUrl = process.env.AGENT_DEVICE_DAEMON_BASE_URL;
  process.env.AGENT_DEVICE_DAEMON_BASE_URL = 'http://127.0.0.1:4310/agent-device';

  try {
    await assert.rejects(
      async () =>
        await sendToDaemon({
          session: 'default',
          command: 'remote-smoke',
          positionals: [],
          flags: { daemonTransport: 'socket' },
          meta: { requestId: 'req-remote-socket' },
        }),
      /only supports HTTP transport/,
    );
  } finally {
    if (previousBaseUrl === undefined) delete process.env.AGENT_DEVICE_DAEMON_BASE_URL;
    else process.env.AGENT_DEVICE_DAEMON_BASE_URL = previousBaseUrl;
  }
});

test('sendToDaemon treats IPv4-mapped loopback remote daemon URLs as local', async () => {
  const previousBaseUrl = process.env.AGENT_DEVICE_DAEMON_BASE_URL;
  const previousAuthToken = process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  process.env.AGENT_DEVICE_DAEMON_BASE_URL = 'http://[::ffff:127.0.0.1]:4310/agent-device';
  delete process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;

  try {
    await assert.rejects(
      async () =>
        await sendToDaemon({
          session: 'default',
          command: 'remote-smoke',
          positionals: [],
          flags: { daemonTransport: 'socket' },
          meta: { requestId: 'req-remote-mapped-loopback' },
        }),
      /only supports HTTP transport/,
    );
  } finally {
    if (previousBaseUrl === undefined) delete process.env.AGENT_DEVICE_DAEMON_BASE_URL;
    else process.env.AGENT_DEVICE_DAEMON_BASE_URL = previousBaseUrl;
    if (previousAuthToken === undefined) delete process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
    else process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = previousAuthToken;
  }
});

test('sendToDaemon requires auth for non-loopback remote daemon URLs', async () => {
  const previousBaseUrl = process.env.AGENT_DEVICE_DAEMON_BASE_URL;
  const previousAuthToken = process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  process.env.AGENT_DEVICE_DAEMON_BASE_URL = 'https://remote-mac.example.test/agent-device';
  delete process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;

  try {
    await assert.rejects(
      async () =>
        await sendToDaemon({
          session: 'default',
          command: 'remote-smoke',
          positionals: [],
          flags: {},
          meta: { requestId: 'req-remote-auth' },
        }),
      /requires daemon authentication/,
    );
  } finally {
    if (previousBaseUrl === undefined) delete process.env.AGENT_DEVICE_DAEMON_BASE_URL;
    else process.env.AGENT_DEVICE_DAEMON_BASE_URL = previousBaseUrl;
    if (previousAuthToken === undefined) delete process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
    else process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = previousAuthToken;
  }
});

test('sendToDaemon preserves explicit remote install paths without uploading', async () => {
  const seenPaths: string[] = [];
  let rpcRequest: Record<string, unknown> | null = null;
  const restoreHttpRequest = mockEventHttpRequest(({ options, body, res }) => {
    seenPaths.push(String(options.path ?? ''));
    if (respondToHealthcheck(options, res)) {
      return;
    }

    rpcRequest = JSON.parse(body) as Record<string, unknown>;
    emitJsonRpcResult(res, 'req-remote-path', {
      ok: true,
      data: { source: 'remote-daemon' },
    });
  });

  try {
    await withRemoteDaemonEnv(async () => {
      const response = await sendToDaemon({
        session: 'default',
        command: 'install',
        positionals: ['com.example.app', 'remote:/srv/builds/Sample.apk'],
        flags: {},
        meta: { requestId: 'req-remote-path' },
      });

      assert.equal(response.ok, true);
      assert.deepEqual(seenPaths, ['/agent-device/health', '/agent-device/rpc']);
      assert.equal((rpcRequest as any)?.params?.positionals?.[1], '/srv/builds/Sample.apk');
      assert.equal((rpcRequest as any)?.params?.meta?.uploadedArtifactId, undefined);
    });
  } finally {
    restoreHttpRequest();
  }
});

test('sendToDaemon prints installing notice before remote install RPC completes', async () => {
  const restoreHttpRequest = mockEventHttpRequest(({ options, res }) => {
    if (respondToHealthcheck(options, res)) {
      return;
    }

    emitJsonRpcResult(res, 'req-installing-notice', {
      ok: true,
      data: { source: 'remote-daemon' },
    });
  });

  try {
    const stderr = await captureInteractiveStderr(async () => {
      await withRemoteDaemonEnv(async () => {
        await sendToDaemon({
          session: 'default',
          command: 'install',
          positionals: ['remote:/srv/builds/Sample.apk'],
          flags: {},
          meta: { requestId: 'req-installing-notice' },
        });
      });
    });

    assert.match(stderr, /Installing\.\.\.\n/);
  } finally {
    restoreHttpRequest();
  }
});

test('sendToDaemon preserves install_source payload metadata for remote HTTP RPC', async () => {
  const seenPaths: string[] = [];
  let rpcRequest: Record<string, unknown> | null = null;
  const restoreHttpRequest = mockEventHttpRequest(({ options, body, res }) => {
    seenPaths.push(String(options.path ?? ''));
    if (respondToHealthcheck(options, res)) {
      return;
    }

    rpcRequest = JSON.parse(body) as Record<string, unknown>;
    emitJsonRpcResult(res, 'req-install-source', {
      ok: true,
      data: { source: 'remote-daemon' },
    });
  });

  try {
    await withRemoteDaemonEnv(async () => {
      const response = await sendToDaemon({
        session: 'default',
        command: 'install_source',
        positionals: [],
        flags: { platform: 'android' },
        meta: {
          requestId: 'req-install-source',
          installSource: {
            kind: 'url',
            url: 'https://example.com/app.apk',
            headers: {},
          },
          retainMaterializedPaths: true,
          materializedPathRetentionMs: 60_000,
        },
      });

      assert.equal(response.ok, true);
      assert.deepEqual(seenPaths, ['/agent-device/health', '/agent-device/rpc']);
      assert.deepEqual((rpcRequest as any)?.params?.meta?.installSource, {
        kind: 'url',
        url: 'https://example.com/app.apk',
        headers: {},
      });
      assert.equal((rpcRequest as any)?.params?.meta?.retainMaterializedPaths, true);
      assert.equal((rpcRequest as any)?.params?.meta?.materializedPathRetentionMs, 60_000);

      seenPaths.length = 0;
      rpcRequest = null;

      const githubArtifactResponse = await sendToDaemon({
        session: 'default',
        command: 'install_source',
        positionals: [],
        flags: { platform: 'android' },
        meta: {
          requestId: 'req-install-source-gh',
          installSource: {
            kind: 'github-actions-artifact',
            owner: 'acme',
            repo: 'mobile',
            runId: 1234567890,
            artifactName: 'app-debug',
          },
        },
      });

      assert.equal(githubArtifactResponse.ok, true);
      assert.deepEqual(seenPaths, ['/agent-device/health', '/agent-device/rpc']);
      assert.deepEqual((rpcRequest as any)?.params?.meta?.installSource, {
        kind: 'github-actions-artifact',
        owner: 'acme',
        repo: 'mobile',
        runId: 1234567890,
        artifactName: 'app-debug',
      });
      assert.equal((rpcRequest as any)?.params?.meta?.uploadedArtifactId, undefined);
    });
  } finally {
    restoreHttpRequest();
  }
});

test('downloadRemoteArtifact times out stalled artifact responses and removes partial files', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-remote-artifact-timeout-'));
  const destinationPath = path.join(tempRoot, 'artifacts', 'screen.png');
  const server = http.createServer((req, res) => {
    if (req.url?.includes('/artifacts/')) {
      res.statusCode = 200;
      res.write('partial-png');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const port = await listenOnLoopback(server);

  try {
    await assert.rejects(
      async () =>
        await downloadRemoteArtifact({
          baseUrl: `http://127.0.0.1:${port}/agent-device`,
          token: 'remote-secret',
          artifactId: 'artifact-timeout',
          destinationPath,
          requestId: 'req-remote-artifact-timeout',
          timeoutMs: 50,
        }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.match(String((error as Error).message), /timed out/i);
        return true;
      },
    );
    assert.equal(fs.existsSync(destinationPath), false);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('downloadRemoteArtifact removes partial files after mid-stream aborts', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-remote-artifact-abort-'));
  const destinationPath = path.join(tempRoot, 'artifacts', 'screen.png');
  const server = http.createServer((req, res) => {
    if (req.url?.includes('/artifacts/')) {
      res.statusCode = 200;
      res.flushHeaders();
      res.write('partial-png');
      setImmediate(() => res.destroy(new Error('server aborted artifact stream')));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const port = await listenOnLoopback(server);

  try {
    await assert.rejects(
      async () =>
        await downloadRemoteArtifact({
          baseUrl: `http://127.0.0.1:${port}/agent-device`,
          token: 'remote-secret',
          artifactId: 'artifact-abort',
          destinationPath,
          requestId: 'req-remote-artifact-abort',
          timeoutMs: 1_000,
        }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.match(String((error as Error).message), /aborted|interrupted|premature|socket/i);
        return true;
      },
    );
    assert.equal(fs.existsSync(destinationPath), false);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('computeDaemonCodeSignature fingerprints the daemon runtime import graph', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-signature-'));
  try {
    const daemonEntryPath = path.join(root, 'src', 'daemon.ts');
    const helperPath = path.join(root, 'src', 'helper.ts');
    const lazyPath = path.join(root, 'src', 'lazy.ts');
    const ignoredPath = path.join(root, 'src', 'ignored.ts');
    fs.mkdirSync(path.dirname(daemonEntryPath), { recursive: true });
    fs.writeFileSync(
      daemonEntryPath,
      [
        "import './helper.ts';",
        'export async function boot() {',
        "  return await import('./lazy.ts');",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(helperPath, 'export const helper = 1;\n', 'utf8');
    fs.writeFileSync(lazyPath, 'export const lazy = 1;\n', 'utf8');
    fs.writeFileSync(ignoredPath, 'export const ignored = 1;\n', 'utf8');

    const initial = computeDaemonCodeSignature(daemonEntryPath, root);
    assert.match(initial, /^graph:3:[0-9a-f]{40}$/);

    fs.writeFileSync(lazyPath, 'export const lazy = 200;\n', 'utf8');
    const changedRuntime = computeDaemonCodeSignature(daemonEntryPath, root);
    assert.notEqual(changedRuntime, initial);

    fs.writeFileSync(ignoredPath, 'export const ignored = 200;\n', 'utf8');
    const changedUnrelated = computeDaemonCodeSignature(daemonEntryPath, root);
    assert.equal(changedUnrelated, changedRuntime);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stopDaemonProcessForTakeover terminates a matching daemon process', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-test-'));
  const daemonDir = path.join(root, 'agent-device', 'dist', 'src', 'internal');
  const daemonScriptPath = path.join(daemonDir, 'daemon.js');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(daemonScriptPath, 'setInterval(() => {}, 1000);\n', 'utf8');
  const daemonProcess = runCmdBackground(process.execPath, [daemonScriptPath], {
    stdio: 'ignore',
    allowFailure: true,
    captureOutput: false,
  });
  void daemonProcess.wait.catch(() => {});
  const child = daemonProcess.child;
  const pid = child.pid;
  assert.ok(pid, 'spawned child should have a pid');

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (readProcessCommand(pid) === null) {
      t.skip('process command inspection is unavailable in this environment');
      return;
    }
    assert.equal(isProcessAlive(pid), true);
    await stopProcessForTakeover(pid, {
      termTimeoutMs: 1_500,
      killTimeoutMs: 1_500,
    });
    const exited = await waitForProcessExit(pid, 1500);
    assert.equal(exited, true);
  } finally {
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
      await waitForProcessExit(pid, 1_500);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stopDaemonProcessForTakeover does not terminate non-daemon process', async () => {
  const daemonProcess = runCmdBackground(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    allowFailure: true,
    captureOutput: false,
  });
  void daemonProcess.wait.catch(() => {});
  const child = daemonProcess.child;
  const pid = child.pid;
  assert.ok(pid, 'spawned child should have a pid');

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(isProcessAlive(pid), true);
    await stopProcessForTakeover(pid, {
      termTimeoutMs: 100,
      killTimeoutMs: 100,
    });
    assert.equal(isProcessAlive(pid), true);
  } finally {
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
      await waitForProcessExit(pid, 1_500);
    }
  }
});
