import assert from 'node:assert/strict';
import { realHostMachineFacts } from './toolbox.fixtures.ts';
import fs from 'node:fs';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  createLiveTestHostEnvironment,
  installFakeManagedAgentBrowser,
  mkdtempForTestSync,
} from '@agent-device/test-kit';

const { cleanupManagedAgentBrowserOrphansMock } = vi.hoisted(() => ({
  cleanupManagedAgentBrowserOrphansMock: vi.fn(),
}));

vi.mock('./agent-browser-lifecycle.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-browser-lifecycle.ts')>()),
  cleanupManagedAgentBrowserOrphans: cleanupManagedAgentBrowserOrphansMock,
}));

import webPlatformPlugin from './index.ts';
import type { PlatformHost } from 'agent-device/plugins';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { runCmd, isExecutablePath, whichCmd } from '@agent-device/host-kit/command';
import { hostFileExists } from '@agent-device/host-kit/host-file';

function cleanupWebBrowserOrphansForDaemonStartup(stateDir: string) {
  const host = {
    ...createLiveTestHostEnvironment(),
    ...realHostMachineFacts(),
    stateDir,
    runCommand: runCmd,
    isFileExecutable: isExecutablePath,
    isFilePresent: hostFileExists,
    isExecutableOnPath: async (executable: string) => await whichCmd(executable, process.env),
    // The reaper and the record probe are the only host process reads this family makes, and both are
    // stood in for below, so the port itself has nothing to answer.
    processes: {
      list: async () => [],
      readIdentities: async () => new Map(),
      expandTree: (rootPids, processes) =>
        [...processes].filter((processInfo) => [...rootPids].includes(processInfo.pid)),
      judgeRecordedLiveness: async (records) => [...records].map(() => 'unobserved' as const),
      readExecutablePaths: async () => new Map(),
      reapOwnedRecords: async () => {
        throw new Error('this suite stands the reap in for');
      },
      withLock: async () => {
        throw new Error('this suite stands the install lock in for');
      },
    } satisfies PlatformHost['processes'],
    // This suite runs the startup cleanup only: it neither streams a command nor starts a detached one.
    startBackgroundCommand: async () => {
      throw new Error('startup cleanup starts no host process');
    },
    launchDetached: async () => {
      throw new Error('startup cleanup starts no detached process');
    },
    emitDiagnostic,
    withDiagnosticTimer,
  };
  return webPlatformPlugin().contributes[0].setup(host).operations.cleanupOrphans;
}

const mockCleanupManagedAgentBrowserOrphans = vi.mocked(cleanupManagedAgentBrowserOrphansMock);

beforeEach(() => {
  mockCleanupManagedAgentBrowserOrphans.mockReset();
});

test('daemon-startup web cleanup passes open web sessions to the reaper', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-daemon-cleanup-');
  try {
    await installFakeManagedAgentBrowser(stateDir);
    await cleanupWebBrowserOrphansForDaemonStartup(stateDir)(['web-session']);

    assert.equal(mockCleanupManagedAgentBrowserOrphans.mock.calls.length, 1);
    assert.equal(mockCleanupManagedAgentBrowserOrphans.mock.calls[0]?.[1], 'daemon-startup');
    expect(mockCleanupManagedAgentBrowserOrphans.mock.calls[0]?.[2]).toEqual({
      env: process.env,
      ownedProcessRecords: undefined,
      emitDiagnostic: expect.any(Function),
      processes: expect.any(Object),
      openWebSessionNames: ['web-session'],
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon-startup web cleanup does not run when the managed backend is absent', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-daemon-cleanup-');
  try {
    await cleanupWebBrowserOrphansForDaemonStartup(stateDir)([]);

    assert.equal(mockCleanupManagedAgentBrowserOrphans.mock.calls.length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
