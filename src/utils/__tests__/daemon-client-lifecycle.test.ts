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
import { sendToDaemon, type DaemonRequest } from '../../daemon/client/daemon-client.ts';
import { computeDaemonCodeSignature } from '../../daemon/code-signature.ts';
import { sendRequest } from '../../daemon/client/daemon-client-transport.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  supportsLoopbackBind,
} from '../../__tests__/test-utils/index.ts';
import { AppError } from '../../kernel/errors.ts';
import { runCmdDetachedMonitored, runCmdSync } from '../exec.ts';
import { readProcessStartTime } from '../host-process.ts';
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

/** Like `startHttpDaemonFixture`, but every RPC call returns `errorResult` as an `{ok:false}` result. */
async function startHttpDaemonErrorFixture(
  errorResult: Record<string, unknown>,
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
            result: { ok: false, error: errorResult },
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

/** Spawns a fake daemon whose owned (mkdtemp'd) state dir is only known at spawn time. */
function installSpawnedHttpDaemonAtOwnedStateDir(
  httpPort: number,
  onStateDir: (stateDir: string) => void,
): void {
  mockRunCmdDetached.mockImplementation((_command, _args, options) => {
    const ownedStateDir = String(options?.env?.AGENT_DEVICE_STATE_DIR);
    onStateDir(ownedStateDir);
    const ownedPaths = resolveDaemonPaths(ownedStateDir);
    writeDaemonInfo(ownedPaths, { httpPort, transport: 'http' });
    writeDaemonLock(ownedPaths, {
      pid: process.pid,
      processStartTime: readProcessStartTime(process.pid) ?? undefined,
    });
    return { pid: process.pid, exited: new Promise(() => {}) };
  });
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

// --- ADR 0012 decision 6, R7 (Fix 1, C1): a repair-armed `replay --save-script`
// that comes back as a HELD divergence (the daemon's `resume.repairSessionHeld`
// signal) must keep its owning (owned/ephemeral) daemon alive and addressable.
// The keep-alive keys on that signal — the REPAIR-ARMED condition — NOT on
// `resume.allowed`, which reports only plan-resumability. ---

function heldDivergenceError(
  resume: Record<string, unknown> = { allowed: true, from: 3, planDigest: 'digest-abc' },
): Record<string, unknown> {
  return {
    code: 'REPLAY_DIVERGENCE',
    message: 'Replay failed at step 3 (click id="save"): selector-miss',
    details: {
      divergence: {
        version: 1,
        kind: 'selector-miss',
        resume: { ...resume, repairSessionHeld: true },
        repairHint: 'record-and-heal',
      },
    },
  };
}

/** A divergence WITHOUT the daemon's held signal — the plain, non-repair case. */
function unheldDivergenceError(): Record<string, unknown> {
  return {
    code: 'REPLAY_DIVERGENCE',
    message: 'Replay failed at step 2 (click id="save"): selector-miss',
    details: {
      divergence: {
        version: 1,
        kind: 'selector-miss',
        resume: { allowed: true, from: 2, planDigest: 'digest-def' },
        repairHint: 'manual',
      },
    },
  };
}

test('sendToDaemon keeps an owned ephemeral daemon alive and hints its --state-dir on a resumable repair divergence', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const daemon = await startHttpDaemonErrorFixture(heldDivergenceError());
  let ownedStateDir = '';
  installSpawnedHttpDaemonAtOwnedStateDir(daemon.port, (dir) => {
    ownedStateDir = dir;
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'replay',
      positionals: ['drifted.ad'],
      flags: { saveScript: true, daemonTransport: 'http' },
      meta: { requestId: 'req-repair-keep-alive' },
    });

    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.equal(response.error.code, 'REPLAY_DIVERGENCE');
    assert.ok(ownedStateDir.length > 0);
    assert.match(String(response.error.hint), /--state-dir/);
    assert.ok(String(response.error.hint).includes(ownedStateDir));

    // The daemon was NOT torn down: metadata and the owned state dir itself
    // are still on disk, addressable by a follow-up command's --state-dir.
    const ownedPaths = resolveDaemonPaths(ownedStateDir);
    assert.equal(fs.existsSync(ownedPaths.infoPath), true);
    assert.equal(fs.existsSync(ownedPaths.lockPath), true);
    assert.equal(fs.existsSync(ownedStateDir), true);
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) fs.rmSync(ownedStateDir, { recursive: true, force: true });
  }
});

test('C1: keep-alive keys on repairSessionHeld, NOT resume.allowed — a HELD divergence with allowed:false still keeps the daemon alive', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  // resume.allowed:false (plan not resumable), but the daemon still HELD the
  // repair session — the agent must be able to reach it to close/inspect.
  const daemon = await startHttpDaemonErrorFixture(
    heldDivergenceError({
      allowed: false,
      from: 2,
      planDigest: 'digest-x',
      reason: 'output-env-skip',
    }),
  );
  let ownedStateDir = '';
  installSpawnedHttpDaemonAtOwnedStateDir(daemon.port, (dir) => {
    ownedStateDir = dir;
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'replay',
      positionals: ['drifted.ad'],
      flags: { saveScript: true, daemonTransport: 'http' },
      meta: { requestId: 'req-held-not-resumable' },
    });

    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.match(String(response.error.hint), /--state-dir/);
    assert.ok(ownedStateDir.length > 0);
    assert.equal(fs.existsSync(ownedStateDir), true);
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) fs.rmSync(ownedStateDir, { recursive: true, force: true });
  }
});

test('sendToDaemon tears down an owned ephemeral daemon on an UNHELD divergence (no repairSessionHeld signal)', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const daemon = await startHttpDaemonErrorFixture(unheldDivergenceError());
  let ownedStateDir = '';
  installSpawnedHttpDaemonAtOwnedStateDir(daemon.port, (dir) => {
    ownedStateDir = dir;
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'replay',
      positionals: ['drifted.ad'],
      flags: { saveScript: true, daemonTransport: 'http' },
      meta: { requestId: 'req-repair-no-keep-alive' },
    });

    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.equal(response.error.hint, undefined);
    assert.ok(ownedStateDir.length > 0);
    // No held signal (`resume.allowed:true` alone is not the keep-alive key) —
    // ordinary one-shot teardown still applies.
    assert.equal(fs.existsSync(ownedStateDir), false);
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) fs.rmSync(ownedStateDir, { recursive: true, force: true });
  }
});

// --- ADR 0012 decision 6 (BLOCKER 2, third follow-up): a one-shot
// `replay --save-script` that completes with no divergence returns SUCCESS
// immediately — the actual healed-script commit is deferred to daemon
// teardown. If that deferred commit then fails, the daemon leaves a
// REPAIR_COMMIT_FAILED tombstone in the owned state dir before exiting. The
// client cleanup must discover it (after waiting for the daemon to actually
// exit) BEFORE deleting the owned state dir, and must surface it in the
// response the caller receives — never silently delete the only evidence of
// the failure while reporting the success already computed for the replay
// itself. ---

test('BLOCKER 2 (third follow-up): a shutdown-time repair commit failure is surfaced and the owned state dir survives', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  // The daemon's RPC response for the replay itself is a plain SUCCESS (the
  // plan completed with no divergence) — exactly what a real daemon would
  // return before its deferred, teardown-time commit has even attempted.
  const daemon = await startHttpDaemonFixture({ session: 'default' });
  let ownedStateDir = '';
  installSpawnedHttpDaemonAtOwnedStateDir(daemon.port, (dir) => {
    ownedStateDir = dir;
    // Simulate the daemon's OWN shutdown handler (`finalizeRepairTeardown`)
    // having already run and left a commit-failure tombstone before this
    // fake process "exits" — the real ordering `stopDaemonProcessForTakeover`
    // depends on (it waits for the process to exit, and the real daemon only
    // exits after teardown finishes writing this file).
    const ownedPaths = resolveDaemonPaths(dir);
    const sessionDir = path.join(ownedPaths.sessionsDir, 'default');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'repair-tombstone.json'),
      `${JSON.stringify({
        owner: 'default',
        reapedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        sourcePath: '/tmp/flow.ad',
        commitFailure: {
          code: 'COMMAND_FAILED',
          message: 'a prior healed script already exists at /tmp/flow.healed.ad',
        },
      })}\n`,
    );
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'replay',
      positionals: ['flow.ad'],
      flags: { saveScript: true, daemonTransport: 'http' },
      meta: { requestId: 'req-repair-commit-fail-teardown' },
    });

    // The client-visible response must surface the deferred commit failure —
    // never the raw success the daemon returned for the replay itself, and
    // never silently swallowed by cleanup.
    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.equal(response.error.code, 'REPAIR_COMMIT_FAILED');
    assert.match(response.error.message, /a prior healed script already exists/);
    assert.ok(response.error.message.includes('replay /tmp/flow.ad --save-script'));

    // The owned state dir — and the tombstone evidence inside it — must
    // survive: never rmSync'd while an unrecovered commit failure is on record.
    assert.ok(ownedStateDir.length > 0);
    assert.equal(fs.existsSync(ownedStateDir), true);
    const ownedPaths = resolveDaemonPaths(ownedStateDir);
    assert.equal(
      fs.existsSync(path.join(ownedPaths.sessionsDir, 'default', 'repair-tombstone.json')),
      true,
    );
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) fs.rmSync(ownedStateDir, { recursive: true, force: true });
  }
});

test('continuation: sendToDaemon keeps the daemon alive on a held divergence even WITHOUT --save-script on the request', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  // The `replay --from` continuation of a repair does NOT repeat --save-script
  // (R2); the daemon still sets `repairSessionHeld` from the PERSISTED armed
  // state, so the client — keying purely off that signal — must keep the daemon
  // alive if the continuation itself diverges, keeping the transaction going.
  const daemon = await startHttpDaemonErrorFixture(heldDivergenceError());
  let ownedStateDir = '';
  installSpawnedHttpDaemonAtOwnedStateDir(daemon.port, (dir) => {
    ownedStateDir = dir;
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'replay',
      positionals: ['drifted.ad'],
      flags: { replayFrom: 3, replayPlanDigest: 'digest-abc', daemonTransport: 'http' },
      meta: { requestId: 'req-continuation-no-save-script' },
    });

    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.ok(ownedStateDir.length > 0);
    assert.equal(fs.existsSync(ownedStateDir), true);
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) fs.rmSync(ownedStateDir, { recursive: true, force: true });
  }
});
