import './session-replay-divergence-retry.fixtures.ts';
import { divergenceFixture } from './session-replay-divergence.fixtures.ts';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { AppError } from '@agent-device/kernel/errors';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { SessionStore } from '../../../session-store.ts';
import { replayDivergenceForTest } from './replay-session-fixture.ts';

const { captureDivergenceObservation, mockDispatchCommand, resetDivergenceCapture } =
  divergenceFixture;
beforeEach(resetDivergenceCapture);

// #1385 P2: the retry deadline is a DELAY-ONLY budget, not a per-attempt
// capture timeout — this loop does not itself bound how long a single
// capture attempt runs, only how much SLEEP time it spends between attempts
// (measured from the first attempt). This test proves that bound is real
// wall-clock behavior, not merely "run the fixed 7-entry delay list": each
// mocked capture attempt here advances the (fake) system clock by 5s to
// stand in for a slow capture, so the 12s deadline is exhausted after just 3
// attempts — far short of the 8 attempts (1 + 7 delays) the array alone would
// allow — proving the deadline, not the array length, is what stopped it.
test('captureDivergenceObservation retryLaunchRace: the 12s deadline bounds retries even when captures themselves consume wall-clock time', async () => {
  vi.useFakeTimers();
  try {
    const root = mkdtempForTestSync('agent-device-replay-divergence-deadline-');
    const sessionStore = new SessionStore(path.join(root, 'sessions'));
    const sessionName = 'default';
    sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

    mockDispatchCommand.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 5_000));
      throw new AppError(
        'COMMAND_FAILED',
        'Android snapshot helper returned insufficient foreground app content',
        { androidSnapshotHelperFailureReason: 'content-poor-app-window', retriable: true },
      );
    });

    const action = {
      ts: 0,
      command: 'click',
      positionals: ['label="Save"'],
      flags: {},
      result: { selectorChain: ['label="Save"', 'id="save"'] },
    };

    const observation = await captureDivergenceObservation({
      session: replayDivergenceForTest(sessionStore, sessionName).session!,
      sessionName,
      observationStore: replayDivergenceForTest(sessionStore, sessionName).observationStore,
      logPath: path.join(root, 'daemon.log'),
      action,
      retryLaunchRace: true,
    });

    expect(observation.state).toBe('unavailable');
    // 1 initial attempt + 2 retries: the 3rd retry's pre-sleep remaining-budget
    // check sees the deadline already passed (3 x 5s = 15s > 12s) and breaks
    // BEFORE a 4th capture — not the 8 attempts the delay array alone permits.
    expect(mockDispatchCommand).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
