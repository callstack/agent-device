import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAgentDeviceDaemonProcess: vi.fn(),
  isProcessAlive: vi.fn(),
  sleep: vi.fn(async () => undefined),
  trySignalProcess: vi.fn(),
  waitForProcessExit: vi.fn(),
}));

vi.mock('../daemon-process.ts', () => ({
  isAgentDeviceDaemonProcess: mocks.isAgentDeviceDaemonProcess,
  trySignalProcess: mocks.trySignalProcess,
}));
vi.mock('../../utils/host-process.ts', () => ({
  isProcessAlive: mocks.isProcessAlive,
  waitForProcessExit: mocks.waitForProcessExit,
}));
vi.mock('../../utils/timeouts.ts', () => ({ sleep: mocks.sleep }));

import { resolveDaemonPaths } from '../config.ts';
import { stopDaemon } from '../daemon-stop.ts';

afterEach(() => {
  vi.clearAllMocks();
});

function createDaemonPaths(): ReturnType<typeof resolveDaemonPaths> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-stop-'));
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(paths.infoPath, JSON.stringify({ pid: 123, processStartTime: 'start-time' }));
  return paths;
}

function removeDaemonPaths(paths: ReturnType<typeof resolveDaemonPaths>): void {
  fs.rmSync(paths.baseDir, { recursive: true, force: true });
}

test('reports not-running when daemon metadata is absent', async () => {
  const paths = resolveDaemonPaths(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-stop-')),
  );

  try {
    const result = await stopDaemon({ paths });
    expect(result).toMatchObject({ stopped: false, mode: 'not-running' });
  } finally {
    removeDaemonPaths(paths);
  }
});

test('refuses to signal a live process whose daemon identity cannot be verified', async () => {
  const paths = createDaemonPaths();
  mocks.isAgentDeviceDaemonProcess.mockReturnValue(false);
  mocks.isProcessAlive.mockReturnValue(true);

  try {
    await assert.rejects(
      async () => await stopDaemon({ paths }),
      (error: { code?: string }) => error.code === 'COMMAND_FAILED',
    );
    expect(mocks.trySignalProcess).not.toHaveBeenCalled();
  } finally {
    removeDaemonPaths(paths);
  }
});

test('refuses to signal a live process when daemon metadata lacks a non-empty start-time identity', async () => {
  const paths = createDaemonPaths();
  fs.writeFileSync(paths.infoPath, JSON.stringify({ pid: 123, processStartTime: ' ' }));
  mocks.isProcessAlive.mockReturnValue(true);

  try {
    await assert.rejects(
      async () => await stopDaemon({ paths }),
      (error: { code?: string }) => error.code === 'COMMAND_FAILED',
    );
    expect(mocks.isAgentDeviceDaemonProcess).not.toHaveBeenCalled();
    expect(mocks.trySignalProcess).not.toHaveBeenCalled();
  } finally {
    removeDaemonPaths(paths);
  }
});

test('treats an exited daemon between identity verification and SIGTERM as not-running', async () => {
  const paths = createDaemonPaths();
  mocks.isAgentDeviceDaemonProcess.mockReturnValue(true);
  mocks.trySignalProcess.mockReturnValue(false);
  mocks.isProcessAlive.mockReturnValue(false);

  try {
    const result = await stopDaemon({ paths });
    expect(result).toMatchObject({ stopped: false, mode: 'not-running' });
  } finally {
    removeDaemonPaths(paths);
  }
});

test('reports graceful cleanup after SIGTERM exits the verified daemon', async () => {
  const paths = createDaemonPaths();
  mocks.isAgentDeviceDaemonProcess.mockReturnValue(true);
  mocks.trySignalProcess.mockReturnValue(true);
  mocks.waitForProcessExit.mockImplementation(async () => {
    fs.rmSync(paths.infoPath, { force: true });
    return true;
  });

  try {
    const result = await stopDaemon({ paths });
    expect(result).toMatchObject({
      stopped: true,
      mode: 'graceful',
      cleanupConfidence: 'known',
      providerReleases: { pending: [] },
    });
    expect(mocks.trySignalProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  } finally {
    removeDaemonPaths(paths);
  }
});

test('re-verifies identity before SIGKILL and reports forced cleanup as unknown', async () => {
  const paths = createDaemonPaths();
  mocks.isAgentDeviceDaemonProcess.mockReturnValue(true);
  mocks.trySignalProcess.mockReturnValue(true);
  mocks.waitForProcessExit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

  try {
    const result = await stopDaemon({ paths });
    expect(result).toMatchObject({
      stopped: true,
      mode: 'forced',
      cleanupConfidence: 'unknown',
      providerReleases: { pending: null },
    });
    expect(mocks.trySignalProcess).toHaveBeenNthCalledWith(1, 123, 'SIGTERM');
    expect(mocks.trySignalProcess).toHaveBeenNthCalledWith(2, 123, 'SIGKILL');
  } finally {
    removeDaemonPaths(paths);
  }
});

test('does not send SIGKILL if the daemon identity changes during the graceful wait', async () => {
  const paths = createDaemonPaths();
  mocks.isAgentDeviceDaemonProcess.mockReturnValueOnce(true).mockReturnValueOnce(false);
  mocks.trySignalProcess.mockReturnValue(true);
  mocks.waitForProcessExit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

  try {
    await stopDaemon({ paths });
    expect(mocks.trySignalProcess).toHaveBeenCalledTimes(1);
    expect(mocks.trySignalProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  } finally {
    removeDaemonPaths(paths);
  }
});
