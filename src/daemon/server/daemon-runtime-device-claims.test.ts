import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../session-teardown.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-teardown.ts')>();
  return {
    ...actual,
    stopSessionAppLog: vi.fn(async () => {}),
    teardownSessionResources: vi.fn(),
  };
});

import { SessionStore } from '../session-store.ts';
import { teardownSessionResources } from '../session-teardown.ts';
import type { SessionState } from '../session-state.ts';
import { teardownDaemonSessionForShutdown } from './daemon-runtime.ts';

const mockTeardownSessionResources = vi.mocked(teardownSessionResources);
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(): { session: SessionState; sessionStore: SessionStore; stateDir: string } {
  const stateDir = mkdtempForTestSync('agent-device-shutdown-claim-');
  roots.push(stateDir);
  const session: SessionState = {
    name: 'claim-session',
    device: { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    createdAt: Date.now(),
    actions: [],
  };
  const sessionStore = new SessionStore(path.join(stateDir, 'sessions'));
  sessionStore.publish(session.name, session);
  return { session, sessionStore, stateDir };
}

test('does not clear a claim after shutdown teardown rejects', async () => {
  const { session, sessionStore } = setup();
  mockTeardownSessionResources.mockRejectedValueOnce(new Error('teardown failed'));
  const afterSuccessfulTeardown = vi.fn(async () => {});

  await teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup(session.name)!,
    sessionStore,
    stderr: { write: () => {} },
    afterSuccessfulTeardown,
  });

  expect(afterSuccessfulTeardown).not.toHaveBeenCalled();
  expect(sessionStore.get(session.name)).toBeUndefined();
});

test('does not clear a claim after shutdown teardown times out', async () => {
  vi.useFakeTimers();
  const { session, sessionStore } = setup();
  mockTeardownSessionResources.mockReturnValueOnce(new Promise(() => {}));
  const afterSuccessfulTeardown = vi.fn(async () => {});

  const teardown = teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup(session.name)!,
    sessionStore,
    stderr: { write: () => {} },
    afterSuccessfulTeardown,
  });
  await vi.advanceTimersByTimeAsync(5_000);
  await teardown;

  expect(afterSuccessfulTeardown).not.toHaveBeenCalled();
  expect(sessionStore.get(session.name)).toBeUndefined();
});
