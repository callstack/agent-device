import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { installFakeManagedAgentBrowser } from '../../__tests__/test-utils/web-managed-agent-browser.ts';

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

import { WEB_DESKTOP_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { SessionStore } from '../session-store.ts';
import { cleanupWebBrowserOrphansForDaemonStartup } from './daemon-runtime.ts';

const mockCleanupManagedAgentBrowserOrphans = vi.mocked(cleanupManagedAgentBrowserOrphansMock);

beforeEach(() => {
  mockCleanupManagedAgentBrowserOrphans.mockReset();
});

test('daemon-startup web cleanup passes open web sessions to the reaper', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-daemon-cleanup-');
  try {
    await installFakeManagedAgentBrowser(stateDir);
    const sessionStore = new SessionStore(path.join(stateDir, 'sessions'));
    sessionStore.set('web-session', {
      name: 'web-session',
      device: WEB_DESKTOP_DEVICE,
      createdAt: Date.now(),
      actions: [],
    });

    await cleanupWebBrowserOrphansForDaemonStartup({ stateDir, sessionStore });

    assert.equal(mockCleanupManagedAgentBrowserOrphans.mock.calls.length, 1);
    assert.equal(mockCleanupManagedAgentBrowserOrphans.mock.calls[0]?.[1], 'daemon-startup');
    assert.deepEqual(mockCleanupManagedAgentBrowserOrphans.mock.calls[0]?.[2], {
      openWebSessionNames: ['web-session'],
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon-startup web cleanup does not run when the managed backend is absent', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-daemon-cleanup-');
  try {
    const sessionStore = new SessionStore(path.join(stateDir, 'sessions'));

    await cleanupWebBrowserOrphansForDaemonStartup({ stateDir, sessionStore });

    assert.equal(mockCleanupManagedAgentBrowserOrphans.mock.calls.length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
