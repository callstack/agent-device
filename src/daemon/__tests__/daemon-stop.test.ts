import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const mocks = vi.hoisted(() => ({ stopAndRetireDaemon: vi.fn() }));
vi.mock('../../daemon-registration-owner.ts', () => ({
  stopAndRetireDaemon: mocks.stopAndRetireDaemon,
}));

import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { stopDaemon } from '../daemon-stop.ts';

afterEach(() => {
  vi.resetAllMocks();
});

function createDaemonPaths(): ReturnType<typeof resolveDaemonPaths> {
  const stateDir = mkdtempForTestSync('agent-device-daemon-stop-');
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(paths.infoPath, JSON.stringify({ pid: 123, processStartTime: 'start-time' }));
  return paths;
}

function removeDaemonPaths(paths: ReturnType<typeof resolveDaemonPaths>): void {
  fs.rmSync(paths.baseDir, { recursive: true, force: true });
}

test('reports not-running when daemon metadata is absent', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-daemon-stop-'));

  try {
    const result = await stopDaemon({ paths });
    expect(result).toMatchObject({ stopped: false, mode: 'not-running' });
  } finally {
    removeDaemonPaths(paths);
  }
});

test('retained identity verification is reported as failure without known cleanup', async () => {
  const paths = createDaemonPaths();
  mocks.stopAndRetireDaemon.mockResolvedValue(retainedExit('identity-unverified'));
  await expect(stopDaemon({ paths })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'daemon_exit_unconfirmed', terminationReason: 'identity-unverified' },
  });
  expect(mocks.stopAndRetireDaemon).toHaveBeenCalledWith({
    paths,
    observed: { pid: 123, startTime: 'start-time' },
    mode: 'graceful',
    termTimeoutMs: 10_000,
    killTimeoutMs: 2_000,
  });
});

test('missing start-time identity is passed to the owning termination operation', async () => {
  const paths = createDaemonPaths();
  fs.writeFileSync(paths.infoPath, JSON.stringify({ pid: 123, processStartTime: ' ' }));
  mocks.stopAndRetireDaemon.mockResolvedValue(retainedExit('missing-start-time'));
  await expect(stopDaemon({ paths })).rejects.toMatchObject({
    details: { terminationReason: 'missing-start-time' },
  });
  expect(mocks.stopAndRetireDaemon).toHaveBeenCalledWith(
    expect.objectContaining({ paths, observed: { pid: 123, startTime: null } }),
  );
});

test('a previously exited verified lifetime is reported as not-running', async () => {
  mocks.stopAndRetireDaemon.mockResolvedValue(retired('already-exited'));
  expect(await stopDaemon({ paths: createDaemonPaths() })).toMatchObject({
    stopped: false,
    mode: 'not-running',
  });
});

test('an already released pid without start time remains not-running without cleanup proof', async () => {
  const paths = createDaemonPaths();
  fs.writeFileSync(paths.infoPath, JSON.stringify({ pid: 123 }));
  mocks.stopAndRetireDaemon.mockResolvedValue({
    status: 'retained',
    reason: 'exit-unconfirmed',
    removedInfo: false,
    termination: { status: 'not-running' },
  });
  expect(await stopDaemon({ paths })).toMatchObject({
    stopped: false,
    mode: 'not-running',
  });
});

test('confirmed TERM exit preserves graceful report behavior and configured budgets', async () => {
  const paths = createDaemonPaths();
  mocks.stopAndRetireDaemon.mockResolvedValue(retired('graceful'));
  expect(await stopDaemon({ paths, graceTimeoutMs: 11, killTimeoutMs: 7 })).toMatchObject({
    stopped: true,
    mode: 'graceful',
    cleanupConfidence: 'known',
    providerReleases: { pending: [] },
  });
  expect(mocks.stopAndRetireDaemon).toHaveBeenCalledWith({
    paths,
    observed: { pid: 123, startTime: 'start-time' },
    mode: 'graceful',
    termTimeoutMs: 11,
    killTimeoutMs: 7,
  });
});

test('confirmed KILL exit preserves unknown provider cleanup', async () => {
  mocks.stopAndRetireDaemon.mockResolvedValue(retired('forced'));
  expect(await stopDaemon({ paths: createDaemonPaths() })).toMatchObject({
    stopped: true,
    mode: 'forced',
    cleanupConfidence: 'unknown',
    providerReleases: { status: 'unknown', pending: null },
    warnings: [expect.stringContaining('force-killed')],
  });
});

test.each(['signal-failed', 'exit-timeout'])(
  '%s cannot become a successful stop',
  async (reason) => {
    mocks.stopAndRetireDaemon.mockResolvedValue(retainedExit(reason));
    await expect(stopDaemon({ paths: createDaemonPaths() })).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'daemon_exit_unconfirmed', terminationReason: reason },
    });
  },
);

function retainedExit(reason: string) {
  return {
    status: 'retained',
    reason: 'exit-unconfirmed',
    removedInfo: false,
    termination: { status: 'retained', reason },
  };
}

function retired(mode: string) {
  return {
    status: 'retired',
    removedInfo: true,
    termination: { status: 'exited', mode, identity: { pid: 123, startTime: 'start-time' } },
  };
}

test.each(['registration-replaced', 'retirement-unconfirmed'])(
  '%s after confirmed exit cannot report a completed retirement',
  async (reason) => {
    const paths = createDaemonPaths();
    mocks.stopAndRetireDaemon.mockResolvedValue({
      ...retired('forced'),
      status: 'retained',
      reason,
      removedInfo: false,
      error: {
        code: 'UNKNOWN',
        message: 'retained',
        hint: 'Inspect retained state.',
        diagnosticId: 'diag-retire',
        logPath: '/retained/daemon.log',
      },
    });
    await expect(stopDaemon({ paths })).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: 'daemon_retirement_unconfirmed',
        retirement: { status: 'retained', reason },
        hint: 'Inspect retained state.',
        diagnosticId: 'diag-retire',
        logPath: '/retained/daemon.log',
      },
    });
    expect(fs.existsSync(paths.infoPath)).toBe(true);
  },
);
