import { test, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../types.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';

vi.mock('../../platforms/apple/core/runner-client.ts', () => ({
  getRunnerSessionSnapshot: vi.fn(),
}));

import { getRunnerSessionSnapshot } from '../../platforms/apple/core/runner-client.ts';
import { refreshRecordingHealth } from '../request-recording-health.ts';

const mockGetRunnerSessionSnapshot = vi.mocked(getRunnerSessionSnapshot);

beforeEach(() => {
  mockGetRunnerSessionSnapshot.mockReset();
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
  mockGetRunnerSessionSnapshot.mockReturnValue({
    alive: true,
    sessionId: 'runner-after',
  });

  await refreshRecordingHealth(session);

  expect(mockGetRunnerSessionSnapshot).toHaveBeenCalledWith('sim-1');
  expect(session.screenRecording?.handle.inspect().invalidatedReason).toBe(
    'iOS runner session restarted during recording',
  );
});
