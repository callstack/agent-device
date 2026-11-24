import { expect, test, vi } from 'vitest';
import type { AndroidObservationHost } from '@agent-device/contracts/android-observation';
import { createAndroidObservationAdapter } from '@agent-device/platform-android';
import { makeAndroidSession } from '../../../__tests__/support/session-factories.ts';
import { expireRefFrame } from '../../../core/ref-frame.ts';
import {
  focusedPackageOf,
  runWithAndroidDialogReadinessCheck,
} from './interaction-touch-android-readiness.ts';

// What blocking-dialog readiness costs a run of taps, end to end. Every one of these `dumpsys`
// spawns is a device round trip on the critical path of an interaction, so the budget is pinned
// here rather than left to whatever the composition of the readiness seams happens to produce.

const NORMAL_FOCUS_DUMP =
  '  mCurrentFocus=Window{a1b2c3 u0 com.agentdevice.tester/com.agentdevice.tester.MainActivity}';

/** The window dump that names Settings instead of the session app: the touch escaped. */
const ESCAPED_FOCUS_DUMP =
  '  mCurrentFocus=Window{a1b2c3 u0 com.android.settings/com.android.settings.Settings}';

function dumpRecorder(stdoutForCall: (call: number) => string) {
  let calls = 0;
  const runAdb = vi.fn<AndroidObservationHost['runAdb']>(async (_device, args) => ({
    exitCode: 0,
    stdout: args.includes('dumpsys') ? stdoutForCall(calls++) : '',
    stderr: '',
  }));
  return {
    runAdb,
    observation: createAndroidObservationAdapter({
      runAdb,
      readSnapshotNodes: async () => [],
      openApp: async () => undefined,
    }),
  };
}

const dumpSpawns = (runAdb: ReturnType<typeof vi.fn<AndroidObservationHost['runAdb']>>) =>
  runAdb.mock.calls.filter(([, args]) => args.includes('dumpsys')).length;

test('a run of taps on a clear screen costs two window dumps per tap', async () => {
  const session = makeAndroidSession('readiness-spawn-budget');
  const { runAdb, observation } = dumpRecorder(() => NORMAL_FOCUS_DUMP);

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
  expect(dumpSpawns(runAdb)).toBe(6);
});

// The escape guard is the route's own verdict on the same screen the after-command readiness read
// just looked at. When that read names another app, the guard decides with its evidence, so a
// guarded press that escaped costs exactly what an unguarded one did: the same two dumps.
test('a guarded press that the after-command read already names outside the app costs no extra dump', async () => {
  const session = makeAndroidSession('readiness-spawn-escaped');
  session.appBundleId = 'com.agentdevice.tester';
  const { runAdb, observation } = dumpRecorder((call) =>
    call === 0 ? NORMAL_FOCUS_DUMP : ESCAPED_FOCUS_DUMP,
  );

  const warning = vi.fn(async () => undefined);
  const outcome = await runWithAndroidDialogReadinessCheck(
    session,
    'press',
    { refContext: undefined, judgeAfterReadiness: warning },
    async () => ({ pressed: true }),
    observation,
  );

  expect(outcome.aborted).toBe(false);
  expect(dumpSpawns(runAdb)).toBe(2);
  // The guard is handed the later read's evidence rather than an empty one.
  expect(warning).toHaveBeenCalledWith(
    { pressed: true },
    { status: 'clear', focusedPackage: 'com.android.settings' },
    { status: 'clear', focusedPackage: 'com.agentdevice.tester' },
  );
});

// Same-app or unread evidence is no verdict, so the guard falls through to its own observation —
// the one read it always spent, now taken at the later position.
test('a guarded press whose after-command read names the app still spends the guard read', async () => {
  const session = makeAndroidSession('readiness-spawn-same-app');
  session.appBundleId = 'com.agentdevice.tester';
  const { runAdb, observation } = dumpRecorder(() => NORMAL_FOCUS_DUMP);

  let guardFocusReads = 0;
  const outcome = await runWithAndroidDialogReadinessCheck(
    session,
    'press',
    {
      refContext: undefined,
      judgeAfterReadiness: async (_result, afterReadiness) => {
        // The route's guard: an unread or same-app focus observes for itself.
        if (focusedPackageOf(afterReadiness) === session.appBundleId) {
          guardFocusReads += 1;
          await observation.readAppFocus(session.device, session.appBundleId!);
        }
        return undefined;
      },
    },
    async () => ({ pressed: true }),
    observation,
  );

  expect(outcome.aborted).toBe(false);
  expect(guardFocusReads).toBe(1);
  // Two readiness dumps plus the guard's own window dump. The later position costs no extra spawn:
  // the guard reads once, as it did at its old position.
  expect(dumpSpawns(runAdb)).toBe(3);
});

// A blocking dialog that appears with the transition is refused by the readiness read before the
// guard speaks. The recovery it may run relaunches the app, so an escape verdict over that UI would
// describe a screen that no longer exists.
test('a blocking dialog that arrives with the transition is refused before the guard runs', async () => {
  const session = makeAndroidSession('readiness-spawn-anr');
  session.appBundleId = 'com.agentdevice.tester';
  const { observation } = dumpRecorder((call) =>
    call === 0
      ? NORMAL_FOCUS_DUMP
      : '  mCurrentFocus=Window{a1b2c3 u0 Application Not Responding: com.agentdevice.tester}',
  );

  const guard = vi.fn(async () => undefined);
  await expect(
    runWithAndroidDialogReadinessCheck(
      session,
      'press',
      { refContext: undefined, judgeAfterReadiness: guard },
      async () => ({ pressed: true }),
      observation,
    ),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  expect(guard).not.toHaveBeenCalled();
});

// A leased session runs no readiness check at all, so the guard is handed no focus evidence from
// either side and observes for itself. The route must not invent a focus for it.
test('a leased session runs no readiness read and hands the guard no focus evidence', async () => {
  const session = makeAndroidSession('readiness-spawn-leased');
  session.appBundleId = 'com.agentdevice.tester';
  session.lease = { leaseProvider: 'limrun' } as typeof session.lease;
  const { runAdb, observation } = dumpRecorder(() => NORMAL_FOCUS_DUMP);

  const seen: Array<[string | undefined, string | undefined]> = [];
  const outcome = await runWithAndroidDialogReadinessCheck(
    session,
    'press',
    {
      refContext: undefined,
      judgeAfterReadiness: async (_result, afterReadiness, beforeReadiness) => {
        seen.push([focusedPackageOf(afterReadiness), focusedPackageOf(beforeReadiness)]);
        return undefined;
      },
    },
    async () => ({ pressed: true }),
    observation,
  );

  expect(seen).toEqual([[undefined, undefined]]);
  expect(outcome).toMatchObject({
    aborted: false,
    readiness: { status: 'clear' },
    runtimeResult: { pressed: true },
  });
  expect(runAdb).not.toHaveBeenCalled();
});
