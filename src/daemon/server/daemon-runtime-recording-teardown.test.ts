import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  localRuntimeOwner,
  type ScreenRecordingCompletion,
  type ScreenRecordingLiveHandle,
} from '@agent-device/contracts/platform';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { screenRecordingResourceStore } from '../screen-recording-resource-store.ts';
import { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';
import {
  resolveDaemonSessionTeardownTimeoutMs,
  SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS,
  teardownDaemonSessionForShutdown,
} from './daemon-runtime.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function makeRecordingSession(params: {
  name: string;
  sessionStore: SessionStore;
  finish: ScreenRecordingLiveHandle['finish'];
}): SessionState {
  const { name, sessionStore, finish } = params;
  const device = {
    platform: 'apple' as const,
    id: 'sim-udid-shutdown',
    name: 'iPhone 15',
    kind: 'simulator' as const,
    booted: true,
  };
  const outPath = path.join(sessionStore.resolveSessionDir(name), 'recording.mp4');
  const handle: ScreenRecordingLiveHandle = {
    inspect: () => ({
      backend: 'simctl recordVideo',
      outPath,
      startedAt: Date.now() - 5_000,
      scope: 'app',
      showTouches: false,
      recordOnlySession: false,
      gestureEvents: [],
    }),
    appendGestureEvents: () => {},
    setTouchReferenceFrame: () => {},
    setRunnerSessionId: () => {},
    invalidate: () => {},
    finish,
    forceCleanup: async () => ({ status: 'cleaned' }),
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: name,
    device: { id: device.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
    owner: localRuntimeOwner('apple'),
    fence: { token: `${name}-fence`, generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: { recordingId: name } },
    metadata: { phase: 'active' },
  });
  screenRecordingResourceStore.write(
    screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(name)),
    envelope,
  );
  return {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
    screenRecording: { handle, envelope },
  };
}

test('daemon session teardown budget extends for an active durable recording', () => {
  const root = mkdtempForTestSync('agent-device-shutdown-recording-budget-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeRecordingSession({
    name: 'budget-session',
    sessionStore,
    finish: async () => ({ status: 'cleanup-pending', reason: 'transport-failed' }),
  });
  const withRecording = resolveDaemonSessionTeardownTimeoutMs(session);
  session.screenRecording = undefined;
  const withoutRecording = resolveDaemonSessionTeardownTimeoutMs(session);

  expect(withRecording - withoutRecording).toBe(SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS);
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
  sessionStore.set(session.name, session);
  const stderrChunks: string[] = [];

  const teardown = teardownDaemonSessionForShutdown({
    session,
    sessionStore,
    stateDir: root,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await teardown;

  expect(finish).toHaveBeenCalledOnce();
  expect(stderrChunks.join('')).not.toMatch(/timed out/);
  expect(sessionStore.get(session.name)).toBeUndefined();
});
