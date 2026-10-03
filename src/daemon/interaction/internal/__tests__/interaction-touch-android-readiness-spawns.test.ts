import { expect, test } from 'vitest';
import { makeAndroidSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { withFakeAdb } from '../../../../__tests__/test-utils/fake-adb.ts';
import { expireRefFrame } from '../../../ref-frame.ts';
import { runWithAndroidDialogReadinessCheck } from '../interaction-touch-android-readiness.ts';
import { androidObservation } from '../../../../platform-runtime.ts';

// What blocking-dialog readiness costs a run of taps, end to end. Every one of these `dumpsys`
// spawns is a device round trip on the critical path of an interaction, so the budget is pinned
// here rather than left to whatever the composition of the readiness seams happens to produce.

const NORMAL_FOCUS_DUMP =
  '  mCurrentFocus=Window{a1b2c3 u0 com.agentdevice.tester/com.agentdevice.tester.MainActivity}';

test('a run of taps on a clear screen costs one window dump per tap', async () => {
  const session = makeAndroidSession('readiness-spawn-budget');

  const dumps = await withFakeAdb(
    (args) => (args[1] === 'dumpsys' ? NORMAL_FOCUS_DUMP : ''),
    async ({ calls }) => {
      for (let tap = 0; tap < 3; tap += 1) {
        const outcome = await runWithAndroidDialogReadinessCheck(
          session,
          'press',
          { refContext: undefined },
          async () => {
            // The dispatch seam every interaction crosses (ADR 0014).
            expireRefFrame(session);
            return { pressed: true };
          },
          androidObservation,
        );
        expect(outcome.aborted).toBe(false);
      }
      return calls.filter((args) => args[1] === 'dumpsys').length;
    },
  );

  // Two checks per tap, one dump each: the focused-window line answers the question, so the
  // second `dumpsys` variant never runs on a clear screen. Neither check may be skipped — a dialog
  // surfaces with no adb traffic at all, so the previous check is evidence about nothing.
  expect(dumps).toBe(6);
});
