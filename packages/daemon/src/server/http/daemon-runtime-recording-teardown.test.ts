import path from 'node:path';
import { teardownDaemonSessionForShutdown } from './server-shutdown.ts';
import { afterEach, expect, test, vi } from 'vitest';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { SessionStore } from '../../core/session-store.ts';
import { makeRecordingSession } from '../../__tests__/support/session-teardown.fixtures.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('daemon shutdown awaits durable recording finalization inside its extended budget', async () => {
  vi.useFakeTimers();
  const root = mkdtempForTestSync('agent-device-shutdown-recording-');
  const sessionStore = new SessionStore(
    path.join(root, 'sessions'),
    createLiveTestHostEnvironment(),
  );
  const completion: ScreenRecordingCompletion = {
    backend: 'simctl recordVideo',
    outPath: path.join(root, 'recording.mp4'),
    startedAt: 1,
    completedAt: 2,
    scope: 'app',
    showTouches: false,
    recordOnlySession: false,
  };
  const finish = vi.fn(
    async () =>
      await new Promise<{ status: 'completed'; result: ScreenRecordingCompletion }>((resolve) => {
        setTimeout(() => resolve({ status: 'completed', result: completion }), 10_000);
      }),
  );
  const session = makeRecordingSession({ name: 'shutdown-recording', sessionStore, finish });
  sessionStore.publish(session.name, session);
  const stderrChunks: string[] = [];

  const teardown = teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup(session.name)!,
    sessionStore,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    platformCleanup: platformResourceCleanupFixture(),
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await teardown;

  expect(finish).toHaveBeenCalledOnce();
  expect(stderrChunks.join('')).not.toMatch(/timed out/);
  expect(sessionStore.get(session.name)).toBeUndefined();
});

test('daemon shutdown resolves durable recording resources through the effective session key', async () => {
  const root = mkdtempForTestSync('agent-device-shutdown-effective-session-');
  const sessionStore = new SessionStore(
    path.join(root, 'sessions'),
    createLiveTestHostEnvironment(),
  );
  const effectiveSessionName = 'cwd:0123456789abcdef:default';
  const session = makeRecordingSession({
    name: effectiveSessionName,
    sessionStore,
    finish: async () => ({
      status: 'completed' as const,
      result: {
        backend: 'simctl recordVideo',
        outPath: path.join(root, 'recording.mp4'),
        startedAt: 1,
        completedAt: 2,
        scope: 'app' as const,
        showTouches: false,
        recordOnlySession: false,
      },
    }),
  });
  session.name = 'default';
  sessionStore.publish(effectiveSessionName, session);
  const stderrChunks: string[] = [];

  await teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup(effectiveSessionName)!,
    sessionStore,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    platformCleanup: platformResourceCleanupFixture(),
  });

  expect(stderrChunks.join('')).not.toMatch(/resource record is missing/);
  expect(sessionStore.get(effectiveSessionName)).toBeUndefined();
});
