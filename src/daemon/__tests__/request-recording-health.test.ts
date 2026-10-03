import { test, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../session-state.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';

vi.mock('../../platform-runtime-apple-resources.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform-runtime-apple-resources.ts')>()),
  appleSessionObservation: { observeRunnerSession: vi.fn() },
}));

import { appleSessionObservation } from '../../platform-runtime-apple-resources.ts';
import { refreshRecordingHealth } from '../request-recording-health.ts';

const mockObserveRunnerSession = vi.mocked(appleSessionObservation.observeRunnerSession);

beforeEach(() => {
  mockObserveRunnerSession.mockReset();
});

function makeIosSimulatorSession(showTouches: boolean): SessionState {
  const session: SessionState = {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'apple',
      appleOs: 'ios',
      target: 'mobile',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    },
  };
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'simctl recordVideo',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches,
    runnerSessionId: 'runner-before',
  });
  return session;
}

test('runner-backed iOS recordings still invalidate on runner restarts', async () => {
  const session = makeIosSimulatorSession(true);
  session.device.kind = 'device';
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    showTouches: true,
    runnerSessionId: 'runner-before',
  });
  mockObserveRunnerSession.mockResolvedValue({
    alive: true,
    sessionId: 'runner-after',
  });

  await refreshRecordingHealth(session);

  expect(mockObserveRunnerSession).toHaveBeenCalledWith('sim-1');
  expect(session.screenRecording?.handle.inspect().invalidatedReason).toBe(
    'iOS runner session restarted during recording',
  );
});

test.each([
  { snapshot: undefined, reason: 'iOS runner session exited during recording' },
  {
    snapshot: { alive: false, sessionId: 'runner-before' },
    reason: 'iOS runner session exited during recording',
  },
  { snapshot: { alive: true, sessionId: 'runner-before' }, reason: undefined },
])('recording health follows runner liveness: $snapshot', async ({ snapshot, reason }) => {
  const session = makeIosSimulatorSession(true);
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    showTouches: true,
    runnerSessionId: 'runner-before',
  });
  mockObserveRunnerSession.mockResolvedValue(snapshot);

  await refreshRecordingHealth(session);

  expect(session.screenRecording.handle.inspect().invalidatedReason).toBe(reason);
});

test('a recording without a runner identity adopts the first live observation', async () => {
  const session = makeIosSimulatorSession(true);
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    showTouches: true,
  });
  mockObserveRunnerSession.mockResolvedValue({ alive: true, sessionId: 'runner-first' });

  await refreshRecordingHealth(session);

  const recording = session.screenRecording.handle.inspect();
  expect(recording.runnerSessionId).toBe('runner-first');
  expect(recording.invalidatedReason).toBeUndefined();
});
