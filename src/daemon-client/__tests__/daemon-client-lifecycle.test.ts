import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
  finishRegisteredDaemonFixture,
  finishRegisteredDaemonFixtures,
} from '../../__tests__/test-utils/registered-daemon-fixture.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetached: vi.fn(),
  runCmdDetachedMonitored: vi.fn(),
  runCmdSync: vi.fn(() => ({ exitCode: 1, stdout: '', stderr: '' })),
}));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(async () => {}),
}));

import { resolveDaemonPaths, type DaemonPaths } from '../../daemon-resolution.ts';
import { sendToDaemon, type DaemonRequest, type DaemonResponse } from '../daemon-client.ts';
import { attachActiveSessionAddressHint } from '../daemon-client-lifecycle.ts';
import { sendRequest } from '../daemon-client-transport.ts';
import type { DaemonRetirementResult } from '../../daemon-registration-owner.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  supportsLoopbackBind,
} from '../../__tests__/test-utils/loopback.ts';
import {
  captureStderr,
  startHttpDaemonFixture,
  type HttpDaemonFixture,
  currentDaemonCodeSignature,
} from '../../__tests__/test-utils/daemon-http-fixture.ts';
import { AppError } from '@agent-device/kernel/errors';
import { tryAcquireProcessLock, inspectProcessLock } from '@agent-device/host-kit/file';
import { runCmdDetachedMonitored, runCmdSync } from '@agent-device/host-kit/command';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { sleep } from '@agent-device/host-kit/retry';
import { readVersion } from '@agent-device/host-kit/version';

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

const actualRetry = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);
const mockRunCmdDetached = vi.mocked(runCmdDetachedMonitored);
const mockRunCmdSync = vi.mocked(runCmdSync);
const mockSleep = vi.mocked(sleep);

afterEach(async () => {
  await finishRegisteredDaemonFixtures();
  mockRunCmdDetached.mockReset();
  mockRunCmdSync.mockClear();
  mockSleep.mockReset();
  mockSleep.mockImplementation(async () => {});
  vi.unstubAllEnvs();
});

function makeTempStateDir(prefix: string): string {
  return mkdtempForTestSync(prefix);
}

function writeDaemonInfo(paths: DaemonPaths, info: DaemonInfoFixture): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    `${JSON.stringify({
      token: info.token ?? 'local-secret',
      pid: info.pid ?? process.pid,
      version: info.version ?? readVersion(),
      codeSignature: info.codeSignature ?? currentDaemonCodeSignature(),
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
  mockSleep.mockImplementation(actualRetry.sleep);
  mockRunCmdDetached.mockImplementation((_command, _args, options) => {
    const ownedStateDir = String(options?.env?.AGENT_DEVICE_STATE_DIR);
    onStateDir(ownedStateDir);
    const ownedPaths = resolveDaemonPaths(ownedStateDir);
    return spawnRegisteredDaemonFixture(
      ownedPaths,
      {
        httpPort,
        token: 'local-secret',
        version: readVersion(),
        codeOrigin: 'checkout',
        codeSignature: currentDaemonCodeSignature(),
      },
      options,
    );
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
  mockSleep.mockImplementation(actualRetry.sleep);
  mockRunCmdDetached.mockImplementation((_command, _args, options) => {
    assert.equal(options?.env?.AGENT_DEVICE_STATE_DIR, paths.baseDir);
    return spawnRegisteredDaemonFixture(
      paths,
      {
        httpPort,
        token: 'local-secret',
        version: readVersion(),
        codeOrigin: 'checkout',
        codeSignature: currentDaemonCodeSignature(),
      },
      options,
    );
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

test('sendToDaemon retains unknown metadata after a spawn failure', async () => {
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
    assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), '{"partial":true}\n');
    assert.equal(fs.readFileSync(paths.lockPath, 'utf8'), 'not-json\n');
    assert.equal(thrown.details?.startError, 'spawn failed 1');
    assert.equal(thrown.details?.startupAttempts, 1);
    const results = thrown.details?.cleanupResults as Array<{
      status: string;
      removedInfo: boolean;
    }>;
    assert.equal(results[0]?.status, 'retained');
    assert.equal(results[0]?.removedInfo, false);
    assert.equal(attempts, 1);
  } finally {
    await finishRegisteredDaemonFixture(stateDir);
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
    await finishRegisteredDaemonFixture(stateDir);
  }
});

test('daemon acquisition reclaims a proven reused owner before publication', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const stateDir = makeTempStateDir('agent-device-daemon-stale-lock-');
  const paths = resolveDaemonPaths(stateDir);
  const daemon = await startHttpDaemonFixture({ via: 'fresh-daemon' });
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  const stale = tryAcquireProcessLock({
    lockDirPath: paths.lockPath,
    owner: { pid: process.pid, startTime: 'stale-start-time', acquiredAtMs: Date.now() },
  });
  assert.equal(stale.status, 'acquired');
  installSpawnedHttpDaemon(paths, daemon.port);

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'stale-lock-smoke',
      positionals: [],
      flags: { stateDir, daemonTransport: 'http' },
      meta: { requestId: 'req-stale-lock' },
    });

    const freshLock = inspectProcessLock(paths.lockPath);
    assert.deepEqual(response, { ok: true, data: { via: 'fresh-daemon' } });
    assert.equal(mockRunCmdDetached.mock.calls.length, 1);
    assert.equal(freshLock.state, 'held');
    if (freshLock.state === 'held') assert.notEqual(freshLock.owner.startTime, 'stale-start-time');
    assert.deepEqual(daemon.seenPaths, ['GET /health', 'POST /rpc']);
  } finally {
    if (stale.status === 'acquired') await stale.acquisition.release();
    await closeLoopbackServer(daemon.server);
    await finishRegisteredDaemonFixture(stateDir);
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
      assert.deepEqual(staleDaemon.seenPaths, []);
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
      await finishRegisteredDaemonFixture(stateDir);
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
  const freshDaemon = await startHttpDaemonFixture({ via: 'fresh-daemon' });
  const unreachable = await startHttpDaemonFixture({ via: 'unused' });
  await closeLoopbackServer(unreachable.server);
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
    await finishRegisteredDaemonFixture(stateDir);
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
    await finishRegisteredDaemonFixture(stateDir);
  }
});

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
  mockSleep.mockImplementation(actualRetry.sleep);
  const child = spawnRegisteredDaemonFixture(
    daemonPaths,
    {
      httpPort: daemon.port,
      token: 'local-secret',
      version: readVersion(),
      codeOrigin: 'checkout',
      codeSignature: currentDaemonCodeSignature(),
    },
    undefined,
  );
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
    const info = await waitForRegisteredDaemonFixture(daemonPaths, child);
    let thrown: unknown;
    try {
      await sendRequest(info, request, 'http', daemonPaths, 50);
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof AppError);
    assert.equal(thrown.message, 'Daemon request timed out');
    assert.equal(
      (thrown.details?.retirement as DaemonRetirementResult | undefined)?.status,
      'retired',
    );
    await child.exited;
    assert.deepEqual(daemon.seenPaths, ['POST /rpc']);
    assert.equal(fs.existsSync(daemonPaths.infoPath), false);
    assert.equal(fs.existsSync(daemonPaths.lockPath), false);
    assert.equal(fs.existsSync(requestFlagPaths.infoPath), true);
    assert.equal(fs.existsSync(requestFlagPaths.lockPath), true);
  } finally {
    await closeLoopbackServer(daemon.server);
    await finishRegisteredDaemonFixture(daemonStateDir);
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
    await finishRegisteredDaemonFixture(stateDir);
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
    await finishRegisteredDaemonFixture(stateDir);
  }
});

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

    const ownedPaths = resolveDaemonPaths(ownedStateDir);
    assert.equal(fs.existsSync(ownedPaths.infoPath), true);
    assert.equal(fs.existsSync(ownedPaths.lockPath), true);
    assert.equal(fs.existsSync(ownedStateDir), true);
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) await finishRegisteredDaemonFixture(ownedStateDir);
  }
});

test('C1: keep-alive keys on repairSessionHeld, NOT resume.allowed — a HELD divergence with allowed:false still keeps the daemon alive', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

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
    if (ownedStateDir) await finishRegisteredDaemonFixture(ownedStateDir);
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
    assert.equal(fs.existsSync(ownedStateDir), false);
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) await finishRegisteredDaemonFixture(ownedStateDir);
  }
});

test('BLOCKER 2 (third follow-up): a shutdown-time repair commit failure is surfaced and the owned state dir survives', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  for (const failRelease of [false, true]) {
    const daemon = await startHttpDaemonFixture({ session: 'default' });
    let ownedStateDir = '';
    installSpawnedHttpDaemonAtOwnedStateDir(daemon.port, (dir) => {
      ownedStateDir = dir;
      fs.writeFileSync(
        path.join(dir, 'repair-on-shutdown.json'),
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

    const originalRmdir = fs.rmdirSync;
    const releaseSpy = vi.spyOn(fs, 'rmdirSync').mockImplementation((target, options) => {
      if (failRelease && target === resolveDaemonPaths(ownedStateDir).lockPath)
        throw Object.assign(new Error('release failed'), { code: 'EBUSY' });
      return originalRmdir(target, options);
    });
    try {
      const response = await sendToDaemon({
        session: 'default',
        command: 'replay',
        positionals: ['flow.ad'],
        flags: { saveScript: true, daemonTransport: 'http' },
        meta: { requestId: 'req-repair-commit-fail-teardown' },
      });

      assert.ok(!response.ok);
      assert.equal(response.error.code, 'REPAIR_COMMIT_FAILED');
      const secondary = response.error.details?.cleanupFailure as
        | { details?: { ownerReleaseUnverified?: boolean }; hint?: string }
        | undefined;
      assert.equal(Boolean(secondary?.details?.ownerReleaseUnverified), failRelease);
      assert.equal(Boolean(secondary?.hint?.startsWith('Restore process inspection')), failRelease);
      assert.match(response.error.message, /a prior healed script already exists/);
      assert.ok(response.error.message.includes('replay /tmp/flow.ad --save-script'));

      assert.ok(ownedStateDir.length > 0);
      assert.equal(fs.existsSync(ownedStateDir), true);
      const ownedPaths = resolveDaemonPaths(ownedStateDir);
      assert.equal(
        fs.existsSync(path.join(ownedPaths.sessionsDir, 'default', 'repair-tombstone.json')),
        true,
      );
    } finally {
      releaseSpy.mockRestore();
      await closeLoopbackServer(daemon.server);
      if (ownedStateDir) await finishRegisteredDaemonFixture(ownedStateDir);
    }
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
    if (ownedStateDir) await finishRegisteredDaemonFixture(ownedStateDir);
  }
});

// --- ADR 0016: on consumption, a `replay` whose script had no terminal
// `close` reports its session as still active (`ReplayCommandResult.
// sessionActive: true`) by design — the named session stays active and the
// caller binds subsequent commands to the returned id. Tearing down the
// owning daemon here (issue #1384) makes that contract unaddressable the
// instant the response is sent. This mirrors the repair-divergence keep-alive
// above, but for a SUCCESSFUL response instead of a held divergence, and has
// no bounded reap of its own (unlike a held repair): an unattended close-less
// replay leaves a live daemon+app session until ordinary idle-reap or an
// explicit `close` ends it — the same lifetime an interactively opened
// session already has. ---

function activeReplaySuccessData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    replayed: 1,
    healed: 0,
    session: 'default',
    sessionActive: true,
    artifactPaths: [],
    message: 'Replayed 1 step in 0.1s',
    ...overrides,
  };
}

test('attachActiveSessionAddressHint shell-quotes a --state-dir/--session value containing spaces or shell metacharacters', () => {
  const unsafeStateDir = '/tmp/state dir with $(danger)';
  const unsafeSession = 'cwd:abc123:my session; rm -rf /';
  const response: Extract<DaemonResponse, { ok: true }> = {
    ok: true,
    data: activeReplaySuccessData({ session: unsafeSession }),
  };

  const hinted = attachActiveSessionAddressHint(response, unsafeStateDir);

  assert.equal(
    hinted.data?.hint,
    "This session's daemon was kept alive because its script left the session active; " +
      `pass --state-dir ${shellQuoteIfNeeded(unsafeStateDir)} ` +
      `--session ${shellQuoteIfNeeded(unsafeSession)} on your next command to reach it.`,
  );
  // Both values actually needed quoting — this test would pass vacuously
  // (raw interpolation indistinguishable from quoted) if they didn't.
  assert.notEqual(shellQuoteIfNeeded(unsafeStateDir), unsafeStateDir);
  assert.notEqual(shellQuoteIfNeeded(unsafeSession), unsafeSession);
});

test('attachActiveSessionAddressHint omits --state-dir but still quotes an unsafe --session-only value', () => {
  const unsafeSession = "cwd:abc123:it's mine";
  const response: Extract<DaemonResponse, { ok: true }> = {
    ok: true,
    data: activeReplaySuccessData({ session: unsafeSession }),
  };

  const hinted = attachActiveSessionAddressHint(response, undefined);

  assert.equal(
    hinted.data?.hint,
    "This session's daemon was kept alive because its script left the session active; " +
      `pass --session ${shellQuoteIfNeeded(unsafeSession)} on your next command to reach it.`,
  );
  assert.doesNotMatch(String(hinted.data?.hint), /--state-dir/);
});

/** Issues a close-less `replay` against an owned ephemeral daemon spawned at `daemonPort`. */
async function replayLeavingSessionActive(
  daemonPort: number,
  requestId: string,
): Promise<{ response: Awaited<ReturnType<typeof sendToDaemon>>; ownedStateDir: string }> {
  let ownedStateDir = '';
  installSpawnedHttpDaemonAtOwnedStateDir(daemonPort, (dir) => {
    ownedStateDir = dir;
  });
  const response = await sendToDaemon({
    session: 'default',
    command: 'replay',
    positionals: ['open-only.ad'],
    flags: { daemonTransport: 'http' },
    meta: { requestId },
  });
  return { response, ownedStateDir };
}

/** Parses a `--state-dir <dir> --session <name>` pair out of an address hint. */
function parseAddressHint(hint: string): { stateDir: string; session: string } {
  const match = hint.match(/--state-dir (\S+) --session (\S+)/);
  assert.ok(match, `hint did not contain a parseable --state-dir/--session pair: ${hint}`);
  return { stateDir: match[1] ?? '', session: match[2] ?? '' };
}

test('sendToDaemon keeps an owned ephemeral daemon alive and hints its --state-dir when a close-less replay leaves the session active', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const daemon = await startHttpDaemonFixture(activeReplaySuccessData());
  let ownedStateDir = '';
  try {
    const result = await replayLeavingSessionActive(daemon.port, 'req-active-session-keep-alive');
    ownedStateDir = result.ownedStateDir;
    assert.equal(result.response.ok, true);
    if (!result.response.ok) return;
    const data = result.response.data;
    assert.ok(data);
    assert.equal(data.session, 'default');
    assert.equal(data.sessionActive, true);
    assert.ok(ownedStateDir.length > 0);
    const hint = String(data.hint);
    assert.match(hint, /--state-dir/);
    assert.ok(hint.includes(ownedStateDir));
    // Names the session verbatim (not just --state-dir): an explicit
    // --session <value> is used as-is by resolveEffectiveSessionName, so the
    // hint must be copy-pasteable into a follow-up command from any cwd.
    assert.match(hint, /--session default/);
    assert.match(String(data.message), /--state-dir/);

    // The daemon was NOT torn down: metadata and the owned state dir itself
    // are still on disk, addressable by a follow-up command's --state-dir.
    const ownedPaths = resolveDaemonPaths(ownedStateDir);
    assert.equal(fs.existsSync(ownedPaths.infoPath), true);
    assert.equal(fs.existsSync(ownedPaths.lockPath), true);
    assert.equal(fs.existsSync(ownedStateDir), true);
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) await finishRegisteredDaemonFixture(ownedStateDir);
  }
});

test('closes the loop: a follow-up sendToDaemon using the hinted --state-dir/--session reaches the SAME kept-alive daemon, without spawning a new one', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const daemon = await startHttpDaemonFixture(activeReplaySuccessData());
  let ownedStateDir = '';
  try {
    const result = await replayLeavingSessionActive(daemon.port, 'req-active-session-hint-source');
    ownedStateDir = result.ownedStateDir;
    assert.equal(result.response.ok, true);
    if (!result.response.ok) return;
    const hinted = parseAddressHint(String(result.response.data?.hint));
    assert.equal(hinted.stateDir, ownedStateDir);

    const spawnCallsBeforeFollowUp = mockRunCmdDetached.mock.calls.length;
    const followUp = await sendToDaemon({
      session: hinted.session,
      command: 'press',
      positionals: [],
      flags: { stateDir: hinted.stateDir, daemonTransport: 'http' },
      meta: { requestId: 'req-active-session-followup', sessionExplicit: true },
    });

    // Reached the SAME kept-alive daemon fixture — no new one was spawned to
    // serve the follow-up — and the request actually carried the hinted
    // session name, closing the loop on the promise the hint makes.
    assert.equal(mockRunCmdDetached.mock.calls.length, spawnCallsBeforeFollowUp);
    assert.equal(followUp.ok, true);
    assert.equal(daemon.rpcRequests.length, 2);
    assert.equal(daemon.rpcRequests[1]?.params?.session, hinted.session);
    assert.equal(daemon.rpcRequests[1]?.params?.command, 'press');
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) await finishRegisteredDaemonFixture(ownedStateDir);
  }
});

test('sendToDaemon tears down an owned ephemeral daemon when replay reports the session was closed (sessionActive: false)', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  const daemon = await startHttpDaemonFixture(activeReplaySuccessData({ sessionActive: false }));
  let ownedStateDir = '';
  installSpawnedHttpDaemonAtOwnedStateDir(daemon.port, (dir) => {
    ownedStateDir = dir;
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'replay',
      positionals: ['closed.ad'],
      flags: { daemonTransport: 'http' },
      meta: { requestId: 'req-closed-session-teardown' },
    });

    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.equal(response.data?.hint, undefined);
    assert.ok(ownedStateDir.length > 0);
    assert.equal(fs.existsSync(ownedStateDir), false);
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) await finishRegisteredDaemonFixture(ownedStateDir);
  }
});

test('ADR 0012 R7 x ADR 0016: a completed --save-script repair also keeps its owning daemon alive (its terminal source close is always skipped)', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  // A repair-armed replay that completes with NO divergence always skips its
  // terminal source `close` (ADR 0012, "the terminal source close ... is
  // SKIPPED — not dispatched"), so the session survives every such run and
  // `sessionActive` is always true here — this falls out of the SAME guard as
  // the plain #1384 case above, but is pinned separately because it changes
  // when the healed `.ad` commit (gated on teardown, not on this response)
  // actually lands: previously immediate (the one-shot client tore the daemon
  // down right after this response), now deferred to an explicit close or
  // idle-reap.
  const daemon = await startHttpDaemonFixture(activeReplaySuccessData({ healed: 1 }));
  let ownedStateDir = '';
  installSpawnedHttpDaemonAtOwnedStateDir(daemon.port, (dir) => {
    ownedStateDir = dir;
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'replay',
      positionals: ['flow.ad'],
      flags: { saveScript: true, daemonTransport: 'http' },
      meta: { requestId: 'req-repair-complete-keep-alive' },
    });

    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.equal(response.data?.sessionActive, true);
    assert.match(String(response.data?.hint), /--state-dir/);

    // No immediate teardown means no immediate commit trigger either: the
    // owned daemon and its state dir are still on disk, exactly like the
    // plain (non-repair) active-session case.
    assert.ok(ownedStateDir.length > 0);
    assert.equal(fs.existsSync(ownedStateDir), true);
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) await finishRegisteredDaemonFixture(ownedStateDir);
  }
});

test('issue #1384: sendToDaemon does not stop a client-started daemon at an explicit --state-dir when replay leaves the session active', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  // The literal #1384 repro: an explicit AGENT_DEVICE_STATE_DIR/--state-dir
  // means `ownedStateDir` is false, but this client still STARTS the daemon
  // fresh at that fixed dir (`daemon.startedByClient`) since nothing was
  // running there yet — the teardown branch this guards is reached
  // regardless of `ownedStateDir`.
  const stateDir = makeTempStateDir('agent-device-active-session-explicit-dir-');
  const paths = resolveDaemonPaths(stateDir);
  const daemon = await startHttpDaemonFixture(activeReplaySuccessData());
  installSpawnedHttpDaemon(paths, daemon.port);

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'replay',
      positionals: ['open-only.ad'],
      flags: { stateDir, daemonTransport: 'http' },
      meta: { requestId: 'req-explicit-dir-active-session' },
    });

    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.equal(response.data?.sessionActive, true);
    // The hint still names --session (the caller can't rediscover a
    // cwd-qualified session name any other way, per #1394) but omits
    // --state-dir — the caller already knows this explicit dir, it passed it
    // itself, so only an OWNED (randomly generated) state dir needs one.
    assert.equal(
      response.data?.hint,
      "This session's daemon was kept alive because its script left the session active; " +
        'pass --session default on your next command to reach it.',
    );
    assert.doesNotMatch(String(response.data?.hint), /--state-dir/);
    assert.equal(fs.existsSync(paths.infoPath), true);
    assert.equal(fs.existsSync(paths.lockPath), true);
  } finally {
    await closeLoopbackServer(daemon.server);
    await finishRegisteredDaemonFixture(stateDir);
  }
});

test('sendToDaemon still tears down a `test` command owned ephemeral daemon even if its response data carried sessionActive:true', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }

  // `test` never actually sets this field in practice (its own per-file
  // runner always closes each session before the suite summary is built) —
  // this proves the carve-out is an explicit command check, not an accident
  // of the response shape, should a future response ever carry it by mistake.
  const daemon = await startHttpDaemonFixture(activeReplaySuccessData({ total: 1 }));
  let ownedStateDir = '';
  installSpawnedHttpDaemonAtOwnedStateDir(daemon.port, (dir) => {
    ownedStateDir = dir;
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'test',
      positionals: ['suite.ad'],
      flags: { daemonTransport: 'http' },
      meta: { requestId: 'req-test-command-teardown' },
    });

    assert.equal(response.ok, true);
    assert.ok(ownedStateDir.length > 0);
    assert.equal(fs.existsSync(ownedStateDir), false);
  } finally {
    await closeLoopbackServer(daemon.server);
    if (ownedStateDir) await finishRegisteredDaemonFixture(ownedStateDir);
  }
});
