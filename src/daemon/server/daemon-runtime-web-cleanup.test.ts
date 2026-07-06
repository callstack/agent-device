import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';

const { cleanupManagedAgentBrowserOrphansMock } = vi.hoisted(() => ({
  cleanupManagedAgentBrowserOrphansMock: vi.fn(),
}));

vi.mock('../../platforms/web/agent-browser-lifecycle.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/web/agent-browser-lifecycle.ts')>();
  return {
    ...actual,
    cleanupManagedAgentBrowserOrphans: cleanupManagedAgentBrowserOrphansMock,
  };
});

import { WEB_DESKTOP_DEVICE } from '../../__tests__/test-utils/index.ts';
import { SessionStore } from '../session-store.ts';
import { cleanupWebBrowserOrphansForDaemonStartup } from './daemon-runtime.ts';
import { installFakeManagedAgentBrowser } from '../../platforms/web/__tests__/test-utils.ts';

const mockCleanupManagedAgentBrowserOrphans = vi.mocked(cleanupManagedAgentBrowserOrphansMock);

beforeEach(() => {
  mockCleanupManagedAgentBrowserOrphans.mockReset();
});

test('daemon-startup web cleanup passes open web sessions to the reaper', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-daemon-cleanup-'));
  try {
    installFakeManagedAgentBrowser(stateDir);
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-daemon-cleanup-'));
  try {
    const sessionStore = new SessionStore(path.join(stateDir, 'sessions'));

    await cleanupWebBrowserOrphansForDaemonStartup({ stateDir, sessionStore });

    assert.equal(mockCleanupManagedAgentBrowserOrphans.mock.calls.length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
