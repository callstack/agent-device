import assert from 'node:assert/strict';
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
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { runCmd, isExecutablePath } from '@agent-device/host-kit/command';

function cleanupWebBrowserOrphansForDaemonStartup(stateDir: string) {
  const host = {
    ...createLiveTestHostEnvironment(),
    stateDir,
    runCommand: runCmd,
    isFileExecutable: isExecutablePath,
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
