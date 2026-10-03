import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  ScreenRecordingLiveHandle,
  ScreenRecordingLiveSnapshot,
  ScreenRecordingStartInput,
} from './screen-recording-runtime.ts';

function seedRunnerSession(
  handle: Pick<ScreenRecordingLiveHandle, 'setRunnerSessionId'>,
  sessionId: string,
): void {
  handle.setRunnerSessionId(sessionId);
}

test('the neutral live handle can seed runner identity after start', () => {
  let observed: string | undefined;
  seedRunnerSession(
    {
      setRunnerSessionId: (sessionId) => {
        observed = sessionId;
      },
    },
    'runner-after-start',
  );
  assert.equal(observed, 'runner-after-start');
});

test('the live snapshot retains the neutral runner gesture clock anchor', () => {
  const timing: Pick<ScreenRecordingLiveSnapshot, 'runnerStartedAtUptimeMs'> = {
    runnerStartedAtUptimeMs: 120,
  };
  assert.deepEqual(timing, {
    runnerStartedAtUptimeMs: 120,
  });
});

test('explicit hide-touches intent remains distinct from normalized touch visibility', () => {
  const normalizedByOwner: Pick<ScreenRecordingStartInput, 'hideTouchesRequested' | 'showTouches'> =
    {
      showTouches: false,
      hideTouchesRequested: false,
    };
  const explicitlyHidden: Pick<ScreenRecordingStartInput, 'hideTouchesRequested' | 'showTouches'> =
    {
      showTouches: false,
      hideTouchesRequested: true,
    };

  assert.equal(normalizedByOwner.showTouches, explicitlyHidden.showTouches);
  assert.notEqual(normalizedByOwner.hideTouchesRequested, explicitlyHidden.hideTouchesRequested);
});
