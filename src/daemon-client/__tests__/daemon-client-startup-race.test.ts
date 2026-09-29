import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(async () => {}),
}));
vi.mock('../../daemon-process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../daemon-process.ts')>();
  return {
    ...actual,
    isAgentDeviceDaemonProcess: vi.fn(
      (pid: number, startTime: string | undefined) =>
        pid === WINNER_PID || actual.isAgentDeviceDaemonProcess(pid, startTime),
    ),
  };
});

import { resolveDaemonPaths, type DaemonPaths } from '../../daemon-resolution.ts';
import { sendToDaemon } from '../daemon-client.ts';
import { runCmdDetachedMonitored, type ExecDetachedExit } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import { readVersion } from '@agent-device/host-kit/version';
import {
  startHttpDaemonFixture,
  type HttpDaemonFixture,
} from '../../__tests__/test-utils/daemon-http-fixture.ts';
import { closeLoopbackServer, supportsLoopbackBind } from '../../__tests__/test-utils/loopback.ts';

// Two clients that find no daemon both launch one; the daemon that loses the startup lock exits
// cleanly. These pin that the losing client adopts the winner instead of tearing it down.

const WINNER_PID = 43_300;
const LOSER_PID = 43_301;

const mockRunCmdDetached = vi.mocked(runCmdDetachedMonitored);
const mockSleep = vi.mocked(sleep);

afterEach(() => {
  mockRunCmdDetached.mockReset();
  mockSleep.mockReset();
  mockSleep.mockImplementation(async () => {});
  vi.unstubAllEnvs();
});

/** Records the winning daemon the way it would: the startup lock, then its reachable metadata. */
function writeWinner(paths: DaemonPaths, fixture: HttpDaemonFixture, parts: 'lock' | 'all'): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.lockPath,
    JSON.stringify({ pid: WINNER_PID, processStartTime: 'winner', startedAt: Date.now() }),
  );
  if (parts === 'lock') return;
  fs.writeFileSync(
    paths.infoPath,
    JSON.stringify({
      token: 'winner-secret',
      pid: WINNER_PID,
      version: readVersion(),
      processStartTime: 'winner',
      httpPort: fixture.port,
      transport: 'http',
    }),
  );
}

test('a client whose daemon lost the startup lock uses the daemon that won it', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  const stateDir = mkdtempForTestSync('agent-device-daemon-start-race-');
  const paths = resolveDaemonPaths(stateDir);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  const fixture = await startHttpDaemonFixture({ devices: [] });
  let launches = 0;
  mockRunCmdDetached.mockImplementation(() => {
    launches += 1;
    writeWinner(paths, fixture, 'lock');
    const exit: ExecDetachedExit = { pid: LOSER_PID, exitCode: 0 };
    return { pid: LOSER_PID, exited: Promise.resolve(exit) };
  });
  mockSleep.mockImplementation(async () => {
    if (!fs.existsSync(paths.infoPath)) writeWinner(paths, fixture, 'all');
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'devices',
      positionals: [],
      flags: { stateDir },
      meta: { requestId: 'req-start-race' },
    });

    assert.equal(response.ok, true);
    assert.equal(launches, 1);
    assert.equal(fixture.rpcRequests.length, 1);
    assert.equal(fs.existsSync(paths.infoPath), true);
    assert.equal(fs.existsSync(paths.lockPath), true);
  } finally {
    await closeLoopbackServer(fixture.server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a one-shot test run leaves a daemon another client started running', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  const stateDir = mkdtempForTestSync('agent-device-daemon-start-race-owner-');
  const paths = resolveDaemonPaths(stateDir);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  const fixture = await startHttpDaemonFixture({ passed: 1, failed: 0 });
  mockRunCmdDetached.mockImplementation(() => {
    writeWinner(paths, fixture, 'all');
    return { pid: LOSER_PID, exited: new Promise<ExecDetachedExit>(() => {}) };
  });

  try {
    const response = await sendToDaemon({
      session: 'default',
      command: 'test',
      positionals: [],
      flags: { stateDir },
      meta: { requestId: 'req-start-race-test' },
    });

    assert.equal(response.ok, true);
    assert.equal(fs.existsSync(paths.infoPath), true);
  } finally {
    await closeLoopbackServer(fixture.server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
