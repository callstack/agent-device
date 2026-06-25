import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';

vi.mock('../exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.ts')>();
  return {
    ...actual,
    runCmdDetached: vi.fn(),
    runCmdDetachedMonitored: vi.fn(),
    runCmdSync: vi.fn(() => ({ exitCode: 1, stdout: '', stderr: '' })),
  };
});

vi.mock('../timeouts.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../timeouts.ts')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

import { resolveDaemonPaths, type DaemonPaths } from '../../daemon/config.ts';
import {
  computeDaemonCodeSignature,
  sendToDaemon,
  type DaemonRequest,
} from '../../daemon-client.ts';
import { sendRequest } from '../../daemon-client-transport.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  supportsLoopbackBind,
} from '../../__tests__/test-utils/index.ts';
import { AppError } from '../errors.ts';
import { runCmdDetachedMonitored, runCmdSync } from '../exec.ts';
import { readProcessStartTime } from '../process-identity.ts';
import { sleep } from '../timeouts.ts';
import { findProjectRoot, readVersion } from '../version.ts';

type DaemonInfoFixture = {
  port?: number;
  httpPort?: number;
  transport: 'socket' | 'http' | 'dual';
  token?: string;
  pid?: number;
  version?: string;
  codeSignature?: string;
  processStartTime?: string;
};

type HttpDaemonFixture = {
  server: http.Server;
  port: number;
  seenPaths: string[];
  rpcRequests: Record<string, any>[];
};

const mockRunCmdDetached = vi.mocked(runCmdDetachedMonitored);
const mockRunCmdSync = vi.mocked(runCmdSync);
const mockSleep = vi.mocked(sleep);

afterEach(() => {
  mockRunCmdDetached.mockReset();
  mockRunCmdSync.mockClear();
  mockSleep.mockClear();
  vi.unstubAllEnvs();
});

function makeTempStateDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function writeDaemonInfo(paths: DaemonPaths, info: DaemonInfoFixture): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    `${JSON.stringify({
      token: info.token ?? 'local-secret',
      pid: info.pid ?? process.pid,
      version: info.version ?? readVersion(),
      codeSignature: info.codeSignature ?? resolveCurrentDaemonCodeSignature(),
      processStartTime: info.processStartTime ?? readProcessStartTime(process.pid) ?? undefined,
      port: info.port,
      httpPort: info.httpPort,
      transport: info.transport,
    })}\n`,
    'utf8',
  );
}

function writeDaemonLock(
  paths: DaemonPaths,
  lock: { pid: number; processStartTime?: string; startedAt?: number },
): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.lockPath,
    `${JSON.stringify({ startedAt: Date.now(), ...lock })}\n`,
    'utf8',
  );
}

async function startHttpDaemonFixture(
  responseData: Record<string, unknown>,
): Promise<HttpDaemonFixture> {
  const seenPaths: string[] = [];
  const rpcRequests: Record<string, any>[] = [];
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
        const rpcRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          any
        >;
        rpcRequests.push(rpcRequest);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpcRequest.id,
            result: { ok: true, data: responseData },
          }),
        );
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
  const port = await listenOnLoopback(server);
  return { server, port, seenPaths, rpcRequests };
}

async function startHangingHttpDaemonFixture(): Promise<HttpDaemonFixture> {
  const seenPaths: string[] = [];
  const rpcRequests: Record<string, any>[] = [];
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
        rpcRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>);
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
  const port = await listenOnLoopback(server);
  return { server, port, seenPaths, rpcRequests };
}

function installSpawnedHttpDaemon(paths: DaemonPaths, httpPort: number): void {
  mockRunCmdDetached.mockImplementation((_command, _args, options) => {
    assert.equal(options?.env?.AGENT_DEVICE_STATE_DIR, paths.baseDir);
    writeDaemonInfo(paths, { httpPort, transport: 'http' });
    writeDaemonLock(paths, {
      pid: process.pid,
      processStartTime: readProcessStartTime(process.pid) ?? undefined,
    });
    return { pid: process.pid, exited: new Promise(() => {}) };
  });
}

function mockSocketConnectionFailures(failingPort: number): {
  ports: number[];
  restore: () => void;
} {
  const ports: number[] = [];
  const originalCreateConnection = net.createConnection;
  (net as unknown as { createConnection: typeof net.createConnection }).createConnection = ((
    ...args: Parameters<typeof net.createConnection>
  ) => {
    const options = args[0] as { port?: number | string };
    if (Number(options.port) !== failingPort) {
      return originalCreateConnection(...args);
    }
    ports.push(Number(options.port));
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      end: () => void;
      setEncoding: (_encoding: string) => void;
      setTimeout: (_ms: number) => typeof socket;
      write: (_chunk: string) => boolean;
    };
    socket.destroy = () => {};
    socket.end = () => {
      socket.emit('close');
    };
    socket.setEncoding = () => {};
    socket.setTimeout = () => socket;
    socket.write = () => true;
    process.nextTick(() => {
      socket.emit('error', new Error('ECONNREFUSED'));
    });
    return socket as unknown as net.Socket;
  }) as typeof net.createConnection;

  return {
    ports,
    restore: () => {
      (net as unknown as { createConnection: typeof net.createConnection }).createConnection =
        originalCreateConnection;
    },
  };
}

function mockSocketErrorAfterWrite(failingPort: number): {
  ports: number[];
  writes: string[];
  restore: () => void;
} {
  const ports: number[] = [];
  const writes: string[] = [];
  const originalCreateConnection = net.createConnection;
  (net as unknown as { createConnection: typeof net.createConnection }).createConnection = ((
    ...args: Parameters<typeof net.createConnection>
  ) => {
    const options = args[0] as { port?: number | string };
    const connectListener = args[1] as (() => void) | undefined;
    if (Number(options.port) !== failingPort) {
      return originalCreateConnection(...args);
    }

    ports.push(Number(options.port));
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      end: () => void;
      setEncoding: (_encoding: string) => void;
      setTimeout: (_ms: number) => typeof socket;
      write: (_chunk: string) => boolean;
    };
    socket.destroy = () => {};
    socket.end = () => {
      socket.emit('close');
    };
    socket.setEncoding = () => {};
    socket.setTimeout = () => socket;
    socket.write = (chunk) => {
      writes.push(chunk);
      process.nextTick(() => {
        socket.emit('error', new Error('ECONNRESET after write'));
      });
      return true;
    };
    process.nextTick(() => connectListener?.());
    return socket as unknown as net.Socket;
  }) as typeof net.createConnection;

  return {
    ports,
    writes,
    restore: () => {
      (net as unknown as { createConnection: typeof net.createConnection }).createConnection =
        originalCreateConnection;
    },
  };
}

test('sendToDaemon retries daemon spawn failures and cleans partial metadata on terminal failure', async () => {
  const stateDir = makeTempStateDir('agent-device-daemon-spawn-retry-');
  const paths = resolveDaemonPaths(stateDir);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  let attempts = 0;

  mockRunCmdDetached.mockImplementation((_command, _args, options) => {
    attempts += 1;
    assert.equal(options?.env?.AGENT_DEVICE_STATE_DIR, stateDir);
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(paths.infoPath, '{"partial":true}\n', 'utf8');
    fs.writeFileSync(paths.lockPath, 'not-json\n', 'utf8');
    throw new Error(`spawn failed ${attempts}`);
  });

  try {
    let thrown: unknown;
    try {
      await sendToDaemon({
        session: 'default',
        command: 'spawn-retry-smoke',
        positionals: [],
        flags: { stateDir },
        meta: { requestId: 'req-spawn-retry' },
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof AppError);
    assert.equal(thrown.message, 'Failed to start daemon');
    assert.equal(thrown.details?.startError, 'spawn failed 2');
    assert.equal(thrown.details?.startupAttempts, 2);
    const cleanupResults = thrown.details?.cleanupResults;
    assert.ok(Array.isArray(cleanupResults));
    assert.deepEqual(
      cleanupResults.map((result) => ({
        reason: result.reason,
        removedInfo: result.removedInfo,
        removedLock: result.removedLock,
      })),
      [
        { reason: 'start_error', removedInfo: true, removedLock: true },
        { reason: 'start_error', removedInfo: true, removedLock: true },
      ],
    );
    assert.equal(attempts, 2);
    assert.equal(mockSleep.mock.calls[0]?.[0], 150);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sendToDaemon reports early daemon exit with log tail and startup paths', async () => {
  const stateDir = makeTempStateDir('agent-device-daemon-early-exit-');
  const paths = resolveDaemonPaths(stateDir);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  let attempts = 0;

  mockRunCmdDetached.mockImplementation((_command, _args, options) => {
    attempts += 1;
    const stderrFd = options?.stdio?.[2];
    if (typeof stderrFd === 'number') {
      fs.writeSync(stderrFd, `early daemon failure ${attempts}\n`);
    }
    return {
      pid: 43_200 + attempts,
      exited: Promise.resolve({ pid: 43_200 + attempts, exitCode: 1 }),
    };
  });

  try {
    let thrown: unknown;
    try {
      await sendToDaemon({
        session: 'default',
        command: 'early-exit-smoke',
        positionals: [],
        flags: { stateDir },
        meta: { requestId: 'req-early-exit' },
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof AppError);
    assert.equal(thrown.message, 'Failed to start daemon');
    assert.equal(thrown.details?.stateDir, paths.baseDir);
    assert.equal(thrown.details?.logPath, paths.logPath);
    assert.match(String(thrown.details?.startError), /daemon process 43202 exited/);
    assert.deepEqual(thrown.details?.daemonProcess, { pid: 43_202, exitCode: 1 });
    assert.match(String(thrown.details?.daemonLogTail), /early daemon failure 2/);
    assert.equal(attempts, 2);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sendToDaemon removes stale daemon lock before spawning a fresh daemon', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const stateDir = makeTempStateDir('agent-device-daemon-stale-lock-');
  const paths = resolveDaemonPaths(stateDir);
  const daemon = await startHttpDaemonFixture({ via: 'fresh-daemon' });
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  writeDaemonLock(paths, {
    pid: process.pid,
    processStartTime: 'stale-start-time',
  });
  installSpawnedHttpDaemon(paths, daemon.port);

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'stale-lock-smoke',
      positionals: [],
      flags: { stateDir, daemonTransport: 'http' },
      meta: { requestId: 'req-stale-lock' },
    });

    const freshLock = JSON.parse(fs.readFileSync(paths.lockPath, 'utf8')) as {
      pid?: number;
      processStartTime?: string;
    };
    assert.deepEqual(response, { ok: true, data: { via: 'fresh-daemon' } });
    assert.equal(mockRunCmdDetached.mock.calls.length, 1);
    assert.equal(freshLock.pid, process.pid);
    assert.notEqual(freshLock.processStartTime, 'stale-start-time');
    assert.deepEqual(daemon.seenPaths, ['GET /health', 'POST /rpc']);
  } finally {
    await closeLoopbackServer(daemon.server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sendToDaemon does not reuse reachable daemon metadata with mismatched version or signature', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const cases: Array<{
    name: string;
    version?: string;
    codeSignature?: string;
    expectedReason: (clientVersion: string) => string;
  }> = [
    {
      name: 'version',
      version: '0.0.0-mismatch',
      expectedReason: (clientVersion) => `version mismatch (client v${clientVersion})`,
    },
    {
      name: 'code-signature',
      codeSignature: 'mismatched-signature',
      expectedReason: () => 'code-signature mismatch',
    },
  ];

  for (const fixture of cases) {
    const stateDir = makeTempStateDir(`agent-device-daemon-${fixture.name}-mismatch-`);
    const paths = resolveDaemonPaths(stateDir);
    const staleDaemon = await startHttpDaemonFixture({ via: 'stale-daemon' });
    const freshDaemon = await startHttpDaemonFixture({ via: 'fresh-daemon' });
    vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
    mockRunCmdDetached.mockReset();
    installSpawnedHttpDaemon(paths, freshDaemon.port);
    writeDaemonInfo(paths, {
      httpPort: staleDaemon.port,
      transport: 'http',
      pid: 999_999,
      ...(fixture.version ? { version: fixture.version } : {}),
      ...(fixture.codeSignature ? { codeSignature: fixture.codeSignature } : {}),
    });
    const stderrCapture = captureStderr();

    try {
      const response = await sendToDaemon({
        session: 'default',
        command: `mismatch-${fixture.name}-smoke`,
        positionals: [],
        flags: { stateDir, daemonTransport: 'http' },
        meta: { requestId: `req-mismatch-${fixture.name}` },
      });

      assert.deepEqual(response, { ok: true, data: { via: 'fresh-daemon' } });
      assert.equal(mockRunCmdDetached.mock.calls.length, 1);
      assert.deepEqual(staleDaemon.seenPaths, ['GET /health']);
      assert.deepEqual(freshDaemon.seenPaths, ['GET /health', 'POST /rpc']);
      const staleVersion = fixture.version ?? readVersion();
      assert.equal(
        stderrCapture.read(),
        `Replacing daemon (pid 999999, v${staleVersion}) in ${paths.baseDir}: ` +
          `${fixture.expectedReason(readVersion())}\n`,
      );
    } finally {
      stderrCapture.restore();
      await closeLoopbackServer(staleDaemon.server);
      await closeLoopbackServer(freshDaemon.server);
      fs.rmSync(stateDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }
});

test('sendToDaemon prints a takeover notice before replacing an unreachable daemon', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const stateDir = makeTempStateDir('agent-device-daemon-unreachable-takeover-');
  const paths = resolveDaemonPaths(stateDir);
  // Grab a loopback port with no listener so the recorded daemon is unreachable.
  const unreachable = await startHttpDaemonFixture({ via: 'unused' });
  await closeLoopbackServer(unreachable.server);
  const freshDaemon = await startHttpDaemonFixture({ via: 'fresh-daemon' });
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  installSpawnedHttpDaemon(paths, freshDaemon.port);
  writeDaemonInfo(paths, {
    httpPort: unreachable.port,
    transport: 'http',
    pid: 999_999,
  });
  const stderrCapture = captureStderr();

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'unreachable-takeover-smoke',
      positionals: [],
      flags: { stateDir, daemonTransport: 'http' },
      meta: { requestId: 'req-unreachable-takeover' },
    });

    assert.deepEqual(response, { ok: true, data: { via: 'fresh-daemon' } });
    assert.equal(
      stderrCapture.read(),
      `Replacing daemon (pid 999999, v${readVersion()}) in ${paths.baseDir}: unreachable\n`,
    );
  } finally {
    stderrCapture.restore();
    await closeLoopbackServer(freshDaemon.server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sendToDaemon replaces socket-only daemon metadata when HTTP transport is requested', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const stateDir = makeTempStateDir('agent-device-daemon-http-takeover-');
  const paths = resolveDaemonPaths(stateDir);
  const freshDaemon = await startHttpDaemonFixture({ via: 'fresh-http-daemon' });
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  installSpawnedHttpDaemon(paths, freshDaemon.port);
  writeDaemonInfo(paths, {
    port: 65_532,
    transport: 'socket',
    pid: 999_999,
  });
  const stderrCapture = captureStderr();

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'http-takeover-smoke',
      positionals: [],
      flags: { stateDir, daemonTransport: 'http' },
      meta: { requestId: 'req-http-takeover' },
    });

    assert.deepEqual(response, { ok: true, data: { via: 'fresh-http-daemon' } });
    assert.equal(mockRunCmdDetached.mock.calls.length, 1);
    assert.deepEqual(freshDaemon.seenPaths, ['GET /health', 'POST /rpc']);
    assert.equal(
      stderrCapture.read(),
      `Replacing daemon (pid 999999, v${readVersion()}) in ${paths.baseDir}: unreachable\n`,
    );
  } finally {
    stderrCapture.restore();
    await closeLoopbackServer(freshDaemon.server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function captureStderr(): { read: () => string; restore: () => void } {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as { write: typeof process.stderr.write }).write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    read: () => captured,
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}

test('sendRequest timeout cleanup uses resolved daemon paths instead of request flags', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const daemonStateDir = makeTempStateDir('agent-device-daemon-timeout-active-');
  const requestFlagStateDir = makeTempStateDir('agent-device-daemon-timeout-request-');
  const daemonPaths = resolveDaemonPaths(daemonStateDir);
  const requestFlagPaths = resolveDaemonPaths(requestFlagStateDir);
  const daemon = await startHangingHttpDaemonFixture();
  writeDaemonInfo(daemonPaths, {
    httpPort: daemon.port,
    transport: 'http',
    pid: 999_999,
  });
  writeDaemonLock(daemonPaths, { pid: 999_999 });
  writeDaemonInfo(requestFlagPaths, {
    httpPort: daemon.port,
    transport: 'http',
    pid: 999_998,
  });
  writeDaemonLock(requestFlagPaths, { pid: 999_998 });

  const request: DaemonRequest = {
    session: 'default',
    command: 'replay',
    positionals: [],
    flags: { stateDir: requestFlagStateDir, daemonTransport: 'http' },
    token: 'local-secret',
    meta: { requestId: 'req-timeout-paths' },
  };

  try {
    let thrown: unknown;
    try {
      await sendRequest(
        {
          token: 'local-secret',
          pid: 999_999,
          httpPort: daemon.port,
          transport: 'http',
        },
        request,
        'http',
        daemonPaths,
        50,
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof AppError);
    assert.equal(thrown.message, 'Daemon request timed out');
    assert.deepEqual(daemon.seenPaths, ['POST /rpc']);
    assert.equal(fs.existsSync(daemonPaths.infoPath), false);
    assert.equal(fs.existsSync(daemonPaths.lockPath), false);
    assert.equal(fs.existsSync(requestFlagPaths.infoPath), true);
    assert.equal(fs.existsSync(requestFlagPaths.lockPath), true);
  } finally {
    await closeLoopbackServer(daemon.server);
    fs.rmSync(daemonStateDir, { recursive: true, force: true });
    fs.rmSync(requestFlagStateDir, { recursive: true, force: true });
  }
});

test('sendToDaemon falls back from failed socket transport to HTTP using daemon metadata ports', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const stateDir = makeTempStateDir('agent-device-daemon-transport-fallback-');
  const paths = resolveDaemonPaths(stateDir);
  const daemon = await startHttpDaemonFixture({ via: 'http-fallback' });
  const socketFailures = mockSocketConnectionFailures(65_530);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  writeDaemonInfo(paths, {
    port: 65_530,
    httpPort: daemon.port,
    transport: 'dual',
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'transport-fallback-smoke',
      positionals: [],
      flags: { stateDir },
      meta: { requestId: 'req-transport-fallback' },
    });

    assert.deepEqual(response, { ok: true, data: { via: 'http-fallback' } });
    assert.deepEqual(socketFailures.ports, [65_530, 65_530]);
    assert.deepEqual(daemon.seenPaths, ['GET /health', 'POST /rpc']);
    assert.equal(daemon.rpcRequests[0]?.params?.command, 'transport-fallback-smoke');
  } finally {
    socketFailures.restore();
    await closeLoopbackServer(daemon.server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sendToDaemon does not replay over HTTP after the socket request is written', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const stateDir = makeTempStateDir('agent-device-daemon-transport-written-');
  const paths = resolveDaemonPaths(stateDir);
  const daemon = await startHttpDaemonFixture({ via: 'unexpected-http-replay' });
  const socket = mockSocketErrorAfterWrite(65_531);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  writeDaemonInfo(paths, {
    port: 65_531,
    httpPort: daemon.port,
    transport: 'dual',
  });

  try {
    let thrown: unknown;
    try {
      await sendToDaemon({
        session: 'default',
        command: 'open',
        positionals: ['Demo'],
        flags: { stateDir },
        meta: { requestId: 'req-transport-written' },
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof AppError);
    assert.equal(thrown.message, 'Failed to communicate with daemon');
    assert.equal(thrown.details?.daemonSocketRequestWritten, true);
    assert.deepEqual(socket.ports, [65_531, 65_531]);
    assert.equal(socket.writes.length, 1);
    assert.deepEqual(daemon.seenPaths, []);
  } finally {
    socket.restore();
    await closeLoopbackServer(daemon.server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
