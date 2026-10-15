import { expect, test, vi } from 'vitest';
import type { AndroidObservationHost } from '@agent-device/contracts/android-observation';
import { createAndroidObservationAdapter } from '@agent-device/platform-android';
import { makeAndroidSession } from '../../../__tests__/support/session-factories.ts';
import { expireRefFrame } from '../../../core/ref-frame.ts';
import { runWithAndroidDialogReadinessCheck } from './interaction-touch-android-readiness.ts';

// What blocking-dialog readiness costs a run of taps, end to end. Every one of these `dumpsys`
// spawns is a device round trip on the critical path of an interaction, so the budget is pinned
// here rather than left to whatever the composition of the readiness seams happens to produce.

const NORMAL_FOCUS_DUMP =
  '  mCurrentFocus=Window{a1b2c3 u0 com.agentdevice.tester/com.agentdevice.tester.MainActivity}';

test('a run of taps on a clear screen costs two window dumps per tap', async () => {
  const session = makeAndroidSession('readiness-spawn-budget');
  const runAdb = vi.fn<AndroidObservationHost['runAdb']>(async (_device, args) => ({
    exitCode: 0,
    stdout: args.includes('dumpsys') ? NORMAL_FOCUS_DUMP : '',
    stderr: '',
  }));
  const observation = createAndroidObservationAdapter({
    runAdb,
    readSnapshotNodes: async () => [],
    openApp: async () => undefined,
  });

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
      observation,
    );
    expect(outcome.aborted).toBe(false);
  }

  // Two checks per tap, one dump each: the focused-window line answers the question, so the
  // second `dumpsys` variant never runs on a clear screen. Neither check may be skipped — a dialog
  // surfaces with no adb traffic at all, so the previous check is evidence about nothing.
  expect(runAdb.mock.calls.filter(([, args]) => args.includes('dumpsys'))).toHaveLength(6);
});
