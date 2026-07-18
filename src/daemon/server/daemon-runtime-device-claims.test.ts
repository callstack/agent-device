import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../session-teardown.ts', () => ({ teardownSessionResources: vi.fn() }));

import { SessionStore } from '../session-store.ts';
import { teardownSessionResources } from '../session-teardown.ts';
import type { SessionState } from '../types.ts';
import { teardownDaemonSessionForShutdown } from './daemon-runtime.ts';

const mockTeardownSessionResources = vi.mocked(teardownSessionResources);
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(): { session: SessionState; sessionStore: SessionStore; stateDir: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-shutdown-claim-'));
  roots.push(stateDir);
  const session: SessionState = {
    name: 'claim-session',
    device: { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    createdAt: Date.now(),
    actions: [],
  };
  const sessionStore = new SessionStore(path.join(stateDir, 'sessions'));
  sessionStore.set(session.name, session);
  return { session, sessionStore, stateDir };
}

test('finalizes provider state but does not clear a claim after shutdown teardown rejects', async () => {
  const { session, sessionStore, stateDir } = setup();
  mockTeardownSessionResources.mockRejectedValueOnce(new Error('teardown failed'));
  const beforeDelete = vi.fn(async () => {});
  const afterSuccessfulTeardown = vi.fn(async () => {});

  await teardownDaemonSessionForShutdown({
    session,
    sessionStore,
    stateDir,
    stderr: { write: () => {} },
    beforeDelete,
    afterSuccessfulTeardown,
  });

  expect(beforeDelete).toHaveBeenCalledWith(session);
  expect(afterSuccessfulTeardown).not.toHaveBeenCalled();
  expect(sessionStore.get(session.name)).toBeUndefined();
});

test('finalizes provider state but does not clear a claim after shutdown teardown times out', async () => {
  vi.useFakeTimers();
  const { session, sessionStore, stateDir } = setup();
  mockTeardownSessionResources.mockReturnValueOnce(new Promise(() => {}));
  const beforeDelete = vi.fn(async () => {});
  const afterSuccessfulTeardown = vi.fn(async () => {});

  const teardown = teardownDaemonSessionForShutdown({
    session,
    sessionStore,
    stateDir,
    stderr: { write: () => {} },
    beforeDelete,
    afterSuccessfulTeardown,
  });
  await vi.advanceTimersByTimeAsync(5_000);
  await teardown;

  expect(beforeDelete).toHaveBeenCalledWith(session);
  expect(afterSuccessfulTeardown).not.toHaveBeenCalled();
  expect(sessionStore.get(session.name)).toBeUndefined();
});
