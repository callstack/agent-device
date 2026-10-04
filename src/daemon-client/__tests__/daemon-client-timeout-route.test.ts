// Production-seam coverage for the real request-timeout route.
//
// src/daemon-client/__tests__/daemon-client-timeout.test.ts covers
// `resolveRequestTimeoutHint` as a pure formatter, but a pure-formatter test cannot catch a bug in
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
// proves the sweep fires for every local timeout except `record` (excluded by
// command, never by platform), and that the HINT text (not the cleanup) is
// what carries the platform-evidence gating.

import net from 'node:net';
import http from 'node:http';

import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test, vi } from 'vitest';

const { mockRunCmdSync } = vi.hoisted(() => ({ mockRunCmdSync: vi.fn() }));

vi.mock('@agent-device/host-kit/command', async () => {
  const actual = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
    '@agent-device/host-kit/command',
  );
  return { ...actual, runCmdSync: mockRunCmdSync };
});

import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { sendRequest } from '../daemon-client-transport.ts';
import type { DaemonRequest } from '../../daemon/daemon-request.ts';
import type { DaemonInfo } from '../daemon-client-metadata.ts';
import { resolveDaemonPaths, type DaemonPaths } from '../../daemon-resolution.ts';
import type { DaemonRetirementResult } from '../../daemon-registration-owner.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
  finishRegisteredDaemonFixture,
  finishRegisteredDaemonFixtures,
} from '../../__tests__/test-utils/registered-daemon-fixture.ts';
import {
  closeLoopbackServer,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';

const TIMEOUT_MS = 120;

// `snapshot`'s timeout policy preserves the daemon (onTimeout !==
// 'reset-daemon'), so `handleRequestTimeout` never signals the daemon
// in the hint controls — keeping them
// side-effect-free outside the mocked pkill sweep.
const SNAPSHOT_COMMAND = 'snapshot';

function dummyStatePaths(): DaemonPaths {
  const baseDir = path.join(
    mkdtempForTestSync('agent-device-timeout-route-test'),
    'agent-device-timeout-route-test',
  );
  return {
    baseDir,
    infoPath: path.join(baseDir, 'daemon.json'),
    lockPath: path.join(baseDir, 'daemon.lock'),
    logPath: path.join(baseDir, 'daemon.log'),
    allocationsDir: path.join(baseDir, 'allocations'),
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
      socket.resume();
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
afterEach(async () => {
  vi.restoreAllMocks();
  await finishRegisteredDaemonFixtures();
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

  // The session-xctestrun pattern is pinned by bytes, not derived from the runner's writer module:
  // a client version in the field already pkills this exact string, and it must keep selecting
  // launches that older writers named, since it cannot know which version started a timed-out
  // launch. Deriving it would move this sweep off those names on any rename.
  const sessionPattern = pkillCalls
    .map(([, args]) => String(args?.[1]))
    .find((pattern) => pattern.includes('session'));
  assert.equal(sessionPattern, String.raw`xcodebuild .*AgentDeviceRunner\.env\.session-`);
  assert.equal(
    new RegExp(sessionPattern).test(
      'xcodebuild test-without-building -xctestrun /d/AgentDeviceRunner.env.session-SIM-1-owner-1-ff-8123.xctestrun',
    ),
    true,
  );
  assert.equal(
    new RegExp(sessionPattern).test(
      'xcodebuild test-without-building -xctestrun /d/AgentDeviceRunner.env.session-SIM-1-8123.xctestrun',
    ),
    true,
  );
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

async function waitForForceStop(requested: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      requested,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('force stop was not requested')), 1_500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function timeoutDiagnostic(paths: DaemonPaths): Record<string, unknown> {
  const events = fs
    .readFileSync(path.join(paths.baseDir, 'timeout-diagnostics.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const event = events.find((entry) => entry.phase === 'daemon_request_timeout');
  assert.ok(event);
  return event.data;
}

function assertForcedRetirement(
  retirement: DaemonRetirementResult | undefined,
  removalFails: boolean,
): void {
  if (removalFails) {
    assert.ok(retirement?.status === 'retained');
    assert.equal(retirement.reason, 'retirement-unconfirmed');
    assert.ok(retirement.termination?.status === 'exited');
    assert.equal(retirement.termination.mode, 'forced');
  } else {
    assert.ok(retirement?.status === 'retired');
    assert.equal(retirement.termination.mode, 'forced');
  }
}

for (const transport of ['socket', 'http'] as const) {
  for (const removalFails of [false, true]) {
    test(`${transport} timeout awaits force exit when metadata removal ${removalFails ? 'fails' : 'succeeds'}`, async (t) => {
      if (await skipWhenLoopbackUnavailable(t)) return;
      mockRunCmdSync.mockReturnValue({ exitCode: 1, stdout: '', stderr: '' });
      const endpoint = await (transport === 'socket'
        ? startHangingSocketServer()
        : startHangingHttpServer());
      const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-timeout-owner-'));
      const child = spawnRegisteredDaemonFixture(
        paths,
        {
          ...(transport === 'socket' ? { socketPort: endpoint.port } : { httpPort: endpoint.port }),
          token: 'test-token',
          version: 'test',
          codeOrigin: 'checkout',
          codeSignature: 'test',
        },
        undefined,
      );
      let exited = false;
      void child.exited.then(() => {
        exited = true;
      });
      let killRequested!: () => void;
      const requested = new Promise<void>((resolve) => {
        killRequested = resolve;
      });
      const actualKill = process.kill.bind(process);
      let settled = false;
      let outcome: Promise<unknown> | undefined;
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === child.pid && signal === 'SIGKILL') {
          killRequested();
          return true;
        }
        return actualKill(pid, signal);
      });
      const actualUnlink = fs.unlinkSync.bind(fs);
      const remove = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
        if (removalFails && file === paths.infoPath)
          throw Object.assign(new Error('retained registration control'), { code: 'EACCES' });
        actualUnlink(file);
      });
      try {
        const info = await waitForRegisteredDaemonFixture(paths, child);
        outcome = withDiagnosticsScope(
          { debug: true, logPath: path.join(paths.baseDir, 'timeout-diagnostics.ndjson') },
          () =>
            sendRequest(
              info,
              { ...buildRequest(undefined), command: 'open' },
              transport,
              paths,
              TIMEOUT_MS,
            ),
        ).then(
          () => assert.fail('hanging request unexpectedly succeeded'),
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        await waitForForceStop(requested);
        await sleep(30);
        assert.equal(actualKill(child.pid, 0), true);
        assert.equal(settled, false, 'request must remain pending while the daemon is alive');
        kill.mockRestore();
        actualKill(child.pid, 'SIGKILL');
        await child.exited;
        const error = await outcome;
        assert.ok(error instanceof AppError);
        assert.equal(normalizeError(error).details?.reason, 'daemon_transport_timeout');
        assertForcedRetirement(
          error.details?.retirement as DaemonRetirementResult | undefined,
          removalFails,
        );
        assert.equal(fs.existsSync(paths.infoPath), removalFails);
        assert.equal(fs.existsSync(paths.lockPath), false);
        assert.equal(fs.existsSync(paths.baseDir), true);
        assert.equal(timeoutDiagnostic(paths).daemonPreservedAfterTimeout, false);
        assert.equal(timeoutDiagnostic(paths).daemonPidForceKilled, true);
        assert.equal(mockRunCmdSync.mock.calls.filter(([cmd]) => cmd === 'pkill').length, 3);
      } finally {
        remove.mockRestore();
        kill.mockRestore();
        if (!exited) actualKill(child.pid, 'SIGKILL');
        await child.exited;
        await outcome;
        await finishRegisteredDaemonFixture(paths.baseDir);
        await closeLoopbackServer(endpoint.server);
      }
    });
  }
}

test('timeout retains a live registration without captured birth proof and reports that outcome', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  mockRunCmdSync.mockReturnValue({ exitCode: 1, stdout: '', stderr: '' });
  const endpoint = await startHangingHttpServer();
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-timeout-retained-'));
  const child = spawnRegisteredDaemonFixture(
    paths,
    {
      httpPort: endpoint.port,
      token: 'test-token',
      version: 'test',
      codeOrigin: 'checkout',
      codeSignature: 'test',
    },
    undefined,
  );
  const kill = vi.spyOn(process, 'kill');
  try {
    const info = await waitForRegisteredDaemonFixture(paths, child);
    const before = fs.readFileSync(paths.infoPath, 'utf8');
    const lockBefore = fs
      .readdirSync(paths.lockPath)
      .map((name) => [name, fs.readFileSync(path.join(paths.lockPath, name), 'utf8')]);
    await assert.rejects(
      withDiagnosticsScope(
        { debug: true, logPath: path.join(paths.baseDir, 'timeout-diagnostics.ndjson') },
        () =>
          sendRequest(
            { ...info, processStartTime: undefined },
            { ...buildRequest(undefined), command: 'open' },
            'http',
            paths,
            TIMEOUT_MS,
          ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(normalizeError(error).details?.reason, 'daemon_transport_timeout');
        const retirement = error.details?.retirement as DaemonRetirementResult | undefined;
        assert.ok(retirement?.status === 'retained');
        assert.ok(retirement.termination?.status === 'retained');
        assert.equal(retirement.termination.reason, 'missing-start-time');
        assert.match(normalizeError(error).hint ?? '', /State was retained/);
        assert.doesNotMatch(normalizeError(error).hint ?? '', /daemon was reset/);
        return true;
      },
    );
    assert.equal(timeoutDiagnostic(paths).daemonPreservedAfterTimeout, true);
    assert.equal(process.kill(child.pid, 0), true);
    assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), before);
    assert.deepEqual(
      fs
        .readdirSync(paths.lockPath)
        .map((name) => [name, fs.readFileSync(path.join(paths.lockPath, name), 'utf8')]),
      lockBefore,
    );
    assert.equal(
      kill.mock.calls.some(([pid, signal]) => pid === child.pid && signal !== 0),
      false,
    );
  } finally {
    kill.mockRestore();
    await finishRegisteredDaemonFixture(paths.baseDir);
    await closeLoopbackServer(endpoint.server);
  }
});

test('a local record stop timeout leaves the exporting daemon and runner alive and names the retry', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  mockRunCmdSync.mockReturnValue({ exitCode: 0, stdout: '', stderr: '' });
  const endpoint = await startHangingSocketServer();
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-record-timeout-owner-'));
  const child = spawnRegisteredDaemonFixture(
    paths,
    {
      socketPort: endpoint.port,
      token: 'test-token',
      version: 'test',
      codeOrigin: 'checkout',
      codeSignature: 'test',
    },
    undefined,
  );
  const kill = vi.spyOn(process, 'kill');
  try {
    const info = await waitForRegisteredDaemonFixture(paths, child);
    const registration = fs.readFileSync(paths.infoPath, 'utf8');
    await assert.rejects(
      sendRequest(
        info,
        {
          ...buildRequest('ios'),
          session: 'e2e-ios-0',
          command: 'record',
          positionals: ['stop'],
        },
        'socket',
        paths,
        TIMEOUT_MS,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'daemon_transport_timeout');
        assert.match(
          error.details?.hint as string,
          /^The daemon may still be exporting the recording\. Run agent-device record stop --session e2e-ios-0 again/,
        );
        return true;
      },
    );
    assert.equal(mockRunCmdSync.mock.calls.length, 0);
    assert.equal(kill.mock.calls.length, 0);
    assert.equal(process.kill(child.pid, 0), true);
    assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), registration);
    assert.equal(fs.existsSync(paths.lockPath), true);
  } finally {
    kill.mockRestore();
    await finishRegisteredDaemonFixture(paths.baseDir);
    await closeLoopbackServer(endpoint.server);
  }
});
