import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, test, vi } from 'vitest';
import {
  createLiveTestHostEnvironment,
  installFakeManagedAgentBrowser,
  mkdtempForTestSync,
} from '@agent-device/test-kit';

const { cleanupManagedAgentBrowserOrphansMock } = vi.hoisted(() => ({
  cleanupManagedAgentBrowserOrphansMock: vi.fn(),
}));

vi.mock('@agent-device/platform-web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-web')>();
  return {
    ...actual,
    cleanupManagedAgentBrowserOrphans: cleanupManagedAgentBrowserOrphansMock,
  };
});

import { createDaemonStartupWebOrphanCleanup } from './daemon-composition.ts';

const cleanupWebBrowserOrphansForDaemonStartup = createDaemonStartupWebOrphanCleanup(
  createLiveTestHostEnvironment(),
);

const mockCleanupManagedAgentBrowserOrphans = vi.mocked(cleanupManagedAgentBrowserOrphansMock);

beforeEach(() => {
  mockCleanupManagedAgentBrowserOrphans.mockReset();
});

test('daemon-startup web cleanup passes open web sessions to the reaper', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-daemon-cleanup-');
  try {
    await installFakeManagedAgentBrowser(stateDir);
    await cleanupWebBrowserOrphansForDaemonStartup({
      stateDir,
      openWebSessionNames: ['web-session'],
    });

    assert.equal(mockCleanupManagedAgentBrowserOrphans.mock.calls.length, 1);
    assert.equal(mockCleanupManagedAgentBrowserOrphans.mock.calls[0]?.[1], 'daemon-startup');
    assert.deepEqual(mockCleanupManagedAgentBrowserOrphans.mock.calls[0]?.[2], {
      env: process.env,
      openWebSessionNames: ['web-session'],
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon-startup web cleanup does not run when the managed backend is absent', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-daemon-cleanup-');
  try {
    await cleanupWebBrowserOrphansForDaemonStartup({
      stateDir,
      openWebSessionNames: [],
    });

    assert.equal(mockCleanupManagedAgentBrowserOrphans.mock.calls.length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
