import { test, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../types.ts';

vi.mock('../../platforms/apple/core/runner/runner-client.ts', () => ({
  getRunnerSessionSnapshot: vi.fn(),
}));

import { getRunnerSessionSnapshot } from '../../platforms/apple/core/runner/runner-client.ts';
import { refreshRecordingHealth } from '../request-recording-health.ts';

const mockGetRunnerSessionSnapshot = vi.mocked(getRunnerSessionSnapshot);

beforeEach(() => {
  mockGetRunnerSessionSnapshot.mockReset();
});

function makeIosSimulatorSession(showTouches: boolean): SessionState {
  return {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'apple',
      target: 'mobile',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    },
    recording: {
      platform: 'ios',
      outPath: '/tmp/demo.mp4',
      startedAt: Date.now() - 1_000,
      showTouches,
      gestureEvents: [],
      runnerSessionId: 'runner-before',
      child: { kill: () => true },
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  };
}

test('runner-backed iOS recordings still invalidate on runner restarts', () => {
  const session = makeIosSimulatorSession(true);
  session.device.kind = 'device';
  session.recording = {
    platform: 'ios-device-runner',
    outPath: '/tmp/demo.mp4',
    remotePath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
    gestureEvents: [],
    runnerSessionId: 'runner-before',
  };
  mockGetRunnerSessionSnapshot.mockReturnValue({
    alive: true,
    sessionId: 'runner-after',
  });

  refreshRecordingHealth(session);

  expect(mockGetRunnerSessionSnapshot).toHaveBeenCalledWith('sim-1');
  expect(session.recording?.invalidatedReason).toBe(
    'iOS runner session restarted during recording',
  );
});
