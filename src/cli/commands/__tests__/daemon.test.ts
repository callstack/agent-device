import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { DaemonStopResult } from '../../../daemon/daemon-stop.ts';

const mocks = vi.hoisted(() => ({
  cleanupRunnerLeasesForOwner: vi.fn(async () => undefined),
  readDaemonShutdownReport: vi.fn(),
  readDaemonStopIdentity: vi.fn(),
  stopDaemon: vi.fn(),
  writeCommandOutput: vi.fn(),
}));

vi.mock('../../../daemon/daemon-stop.ts', () => ({
  readDaemonStopIdentity: mocks.readDaemonStopIdentity,
  stopDaemon: mocks.stopDaemon,
}));
vi.mock('../../../daemon/daemon-shutdown-report.ts', () => ({
  readDaemonShutdownReport: mocks.readDaemonShutdownReport,
}));
vi.mock('../../../platforms/apple/core/runner/runner-lease.ts', () => ({
  cleanupRunnerLeasesForOwner: mocks.cleanupRunnerLeasesForOwner,
}));
vi.mock('../../../platforms/apple/core/runner/runner-disposal.ts', () => ({
  runnerLeaseCleanupAdapter: {},
}));
vi.mock('../shared.ts', () => ({ writeCommandOutput: mocks.writeCommandOutput }));

import { daemonCommand } from '../daemon.ts';

const GRACEFUL_RESULT: DaemonStopResult = {
  stopped: true,
  mode: 'graceful',
  cleanupConfidence: 'known',
  claimsReleased: [],
  claimsOrphaned: [],
  providerReleases: { status: 'completed', released: [], pending: [] },
  warnings: [],
};

afterEach(() => {
  vi.clearAllMocks();
});

test('accepts only daemon stop', async () => {
  await assert.rejects(
    async () =>
      await daemonCommand({
        positionals: [],
        flags: { help: false, json: false, version: false },
        client: {} as never,
      }),
    (error: { code?: string }) => error.code === 'INVALID_ARGS',
  );
  await assert.rejects(
    async () =>
      await daemonCommand({
        positionals: ['stop', 'extra'],
        flags: { help: false, json: false, version: false },
        client: {} as never,
      }),
    (error: { code?: string }) => error.code === 'INVALID_ARGS',
  );
});

test('merges a graceful shutdown report and cleans runner leases with the start-time identity', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-command-'));
  mocks.readDaemonStopIdentity.mockReturnValue({ pid: 123, processStartTime: 'start-time' });
  mocks.stopDaemon.mockResolvedValue(GRACEFUL_RESULT);
  mocks.readDaemonShutdownReport.mockReturnValue({
    providerReleases: {
      released: [{ leaseId: 'lease-1', provider: 'limrun' }],
      pending: [],
    },
  });

  try {
    await daemonCommand({
      positionals: ['stop'],
      flags: { clean: true, help: false, json: false, stateDir, version: false },
      client: {} as never,
    });

    expect(mocks.cleanupRunnerLeasesForOwner).toHaveBeenCalledWith(
      { pid: 123, startTime: 'start-time' },
      {},
    );
    expect(mocks.writeCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({ clean: true, json: false }),
      expect.objectContaining({
        clean: true,
        providerReleases: {
          status: 'completed',
          released: [{ leaseId: 'lease-1', provider: 'limrun' }],
          pending: [],
        },
      }),
      expect.any(Function),
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('reports graceful provider cleanup as unknown when the shutdown report is unavailable', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-command-'));
  mocks.readDaemonStopIdentity.mockReturnValue(null);
  mocks.stopDaemon.mockResolvedValue(GRACEFUL_RESULT);
  mocks.readDaemonShutdownReport.mockReturnValue(null);

  try {
    await daemonCommand({
      positionals: ['stop'],
      flags: { help: false, json: false, stateDir, version: false },
      client: {} as never,
    });

    expect(mocks.writeCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({ json: false }),
      expect.objectContaining({
        clean: false,
        cleanupConfidence: 'unknown',
        providerReleases: { status: 'unknown', released: [], pending: null },
        warnings: [expect.stringContaining('provider cleanup state is unknown')],
      }),
      expect.any(Function),
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
