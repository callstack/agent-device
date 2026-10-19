import fs from 'node:fs';
import { teardownDaemonSessionForShutdown } from './server-shutdown.ts';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';

vi.mock('../../sessions/session-teardown.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sessions/session-teardown.ts')>();
  return {
    ...actual,
    stopSessionAppLog: vi.fn(async () => {}),
    teardownSessionResources: vi.fn(),
  };
});

import { SessionStore } from '../../core/session-store.ts';
import { teardownSessionResources } from '../../sessions/session-teardown.ts';
import type { SessionState } from '../../core/session-state.ts';

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
  const sessionStore = new SessionStore(
    path.join(stateDir, 'sessions'),
    createLiveTestHostEnvironment(),
  );
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
    platformCleanup: platformResourceCleanupFixture(),
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
    platformCleanup: platformResourceCleanupFixture(),
  });
  await vi.advanceTimersByTimeAsync(5_000);
  await teardown;

  expect(afterSuccessfulTeardown).not.toHaveBeenCalled();
  expect(sessionStore.get(session.name)).toBeUndefined();
});
