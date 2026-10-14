import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import { SessionStore } from '@agent-device/daemon/testing/session-store';
import { makeRecordingSession } from '@agent-device/daemon/testing/__tests__/session-teardown.fixtures';
import { teardownDaemonSessionForShutdown } from '@agent-device/daemon/server/daemon-runtime';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('daemon shutdown awaits durable recording finalization inside its extended budget', async () => {
  vi.useFakeTimers();
  const root = mkdtempForTestSync('agent-device-shutdown-recording-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
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
    platformCleanup: platformResourceCleanup,
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await teardown;

  expect(finish).toHaveBeenCalledOnce();
  expect(stderrChunks.join('')).not.toMatch(/timed out/);
  expect(sessionStore.get(session.name)).toBeUndefined();
});

test('daemon shutdown resolves durable recording resources through the effective session key', async () => {
  const root = mkdtempForTestSync('agent-device-shutdown-effective-session-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
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
    platformCleanup: platformResourceCleanup,
  });

  expect(stderrChunks.join('')).not.toMatch(/resource record is missing/);
  expect(sessionStore.get(effectiveSessionName)).toBeUndefined();
});
