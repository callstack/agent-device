// Production-seam coverage for the real request-timeout route.
//
// src/daemon/client/__tests__/daemon-client.test.ts covers `resolveRequestTimeoutHint`
// as a pure formatter, but a pure-formatter test cannot catch a bug in
// CLEANUP ELIGIBILITY: whether `cleanupTimedOutIosRunnerBuilds` (the Apple
// xcodebuild pkill sweep) actually runs. This file spies on the real
// process-execution seam (`runCmdSync`, @agent-device/host-kit/command) and drives an
// actual socket/HTTP timeout through `sendRequest` so the assertions exercise
// the same code path a real client does.
//
// Why cleanup eligibility must stay unconditional for local timeouts: the
// client's declared --platform is not authoritative for session-bound
// execution. `applyStripLockPolicy` (src/daemon/request-lock-policy.ts) lets
// an existing session's real device platform silently override a conflicting
// declared selector under --session-lock strip, and the common session-bound
// request omits --platform entirely. So a request declaring `platform:
// 'android'` can still legitimately execute against an Apple-bound session
// (the "rebound-session" case below), and a request with no platform at all
// (the "unknown-session" case) is the common route the original bug misled.
// A design that skips the pkill sweep based on the declared flag alone would
// skip real cleanup in the rebound case — the dangerous direction. This test
// proves the sweep always fires for local timeouts, and that the HINT text
// (not the cleanup) is what carries the platform-evidence gating.

import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { mockRunCmdSync } = vi.hoisted(() => ({ mockRunCmdSync: vi.fn() }));

vi.mock('@agent-device/host-kit/command', async () => {
  const actual = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
    '@agent-device/host-kit/command',
  );
  return { ...actual, runCmdSync: mockRunCmdSync };
});

import { AppError } from '@agent-device/kernel/errors';
import { sendRequest } from '../daemon-client-transport.ts';
import type { DaemonRequest } from '../../types.ts';
import type { DaemonInfo } from '../daemon-client-metadata.ts';
import type { DaemonPaths } from '../../config.ts';

const TIMEOUT_MS = 120;

// `snapshot`'s timeout policy preserves the daemon (onTimeout !==
// 'reset-daemon'), so `handleRequestTimeout` never reaches
// `resetDaemonAfterTimeout` (`process.kill`) here — keeping this suite
// side-effect-free outside the mocked pkill sweep.
const SNAPSHOT_COMMAND = 'snapshot';

function dummyStatePaths(): DaemonPaths {
  const baseDir = path.join(os.tmpdir(), 'agent-device-timeout-route-test');
  return {
    baseDir,
    infoPath: path.join(baseDir, 'daemon.json'),
    lockPath: path.join(baseDir, 'daemon.lock'),
    logPath: path.join(baseDir, 'daemon.log'),
    sessionsDir: path.join(baseDir, 'sessions'),
  };
}

function buildRequest(platform: 'android' | 'ios' | undefined): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command: SNAPSHOT_COMMAND,
    positionals: [],
    flags: platform ? { platform } : {},
    meta: { requestId: 'req-timeout-route' },
  };
}

function startHangingSocketServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      // Accept the connection but never write a response — forces the
      // client's own request-timeout envelope to fire.
      socket.on('error', () => {});
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({ server, port: address.port });
      } else {
        reject(new Error('failed to bind hanging socket test server'));
      }
    });
  });
}

function startHangingHttpServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      // Never call res.end() — forces the client's own request-timeout
      // envelope to fire instead of a real response.
      res.on('error', () => {});
    });
    server.on('clientError', (_err, socket) => socket.destroy());
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({ server, port: address.port });
      } else {
        reject(new Error('failed to bind hanging http test server'));
      }
    });
  });
}

beforeEach(() => {
  mockRunCmdSync.mockReset();
});

test('socket timeout: pkill cleanup still runs for a declared non-Apple platform that actually terminates a runner (rebound-session case), and the hint claims Apple on that evidence', async () => {
  // Simulates --session-lock strip silently rebinding this request onto an
  // existing Apple session: the client declared `platform: 'android'`, but
  // real Apple xcodebuild work was in flight and the pkill sweep kills it.
  mockRunCmdSync.mockImplementation((cmd: string) =>
    cmd === 'pkill'
      ? { exitCode: 0, stdout: '', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: '' },
  );

  const { server, port } = await startHangingSocketServer();
  try {
    const info: DaemonInfo = { port, token: 'test-token', pid: process.pid };
    const req = buildRequest('android');

    await assert.rejects(
      sendRequest(info, req, 'socket', dummyStatePaths(), TIMEOUT_MS),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(error.details?.hint as string, /Apple runner work was aborted when detected/);
        return true;
      },
    );
  } finally {
    server.close();
  }

  // The eligibility assertion: cleanup ran (all three kill patterns
  // attempted) even though the request declared a non-Apple platform. A
  // design that skips cleanup based on the declared flag would fail this.
  const pkillCalls = mockRunCmdSync.mock.calls.filter(([cmd]) => cmd === 'pkill');
  assert.equal(pkillCalls.length, 3);
});

test('http timeout: pkill cleanup still runs for an undeclared platform (unknown-session case) that terminates nothing, and the hint stays platform-neutral', async () => {
  // Simulates the common session-bound request that never repeats
  // --platform, on a real Android/web/Harmony session: no processes match
  // the Apple-specific kill patterns.
  mockRunCmdSync.mockImplementation(() => ({ exitCode: 1, stdout: '', stderr: '' }));

  const { server, port } = await startHangingHttpServer();
  try {
    const info: DaemonInfo = { httpPort: port, token: 'test-token', pid: process.pid };
    const req = buildRequest(undefined);

    await assert.rejects(
      sendRequest(info, req, 'http', dummyStatePaths(), TIMEOUT_MS),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        const hint = error.details?.hint as string;
        assert.doesNotMatch(hint, /Apple/);
        assert.match(
          hint,
          /The timed-out snapshot request was canceled; the daemon was kept alive/,
        );
        return true;
      },
    );
  } finally {
    server.close();
  }

  // Cleanup still ran — this is the regression this suite exists to catch:
  // an eligibility design keyed off the (here, absent) declared platform
  // would either skip cleanup entirely or — under the original unconditional
  // hint — falsely claim Apple involvement anyway. Neither happens here.
  const pkillCalls = mockRunCmdSync.mock.calls.filter(([cmd]) => cmd === 'pkill');
  assert.equal(pkillCalls.length, 3);
});

test('http timeout: an explicitly declared Apple platform keeps the Apple hint even when the sweep terminates nothing', async () => {
  mockRunCmdSync.mockImplementation(() => ({ exitCode: 1, stdout: '', stderr: '' }));

  const { server, port } = await startHangingHttpServer();
  try {
    const info: DaemonInfo = { httpPort: port, token: 'test-token', pid: process.pid };
    const req = buildRequest('ios');

    await assert.rejects(
      sendRequest(info, req, 'http', dummyStatePaths(), TIMEOUT_MS),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(error.details?.hint as string, /Apple runner work was aborted when detected/);
        return true;
      },
    );
  } finally {
    server.close();
  }

  const pkillCalls = mockRunCmdSync.mock.calls.filter(([cmd]) => cmd === 'pkill');
  assert.equal(pkillCalls.length, 3);
});

test('remote HTTP timeout never runs the Apple pkill cleanup and uses the remote-specific hint', async () => {
  mockRunCmdSync.mockImplementation(() => ({ exitCode: 0, stdout: '', stderr: '' }));

  const { server, port } = await startHangingHttpServer();
  try {
    const info: DaemonInfo = {
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'test-token',
      pid: process.pid,
    };
    const req = buildRequest('android');

    await assert.rejects(
      sendRequest(info, req, 'http', dummyStatePaths(), TIMEOUT_MS),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(
          error.details?.hint as string,
          /verify the remote daemon URL, auth token, and remote host logs/,
        );
        return true;
      },
    );
  } finally {
    server.close();
  }

  assert.equal(mockRunCmdSync.mock.calls.length, 0);
});
