import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { withFakeAdb } from './test-utils/fake-adb.ts';
import {
  createAndroidWindowDumpReader,
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
  resetAndroidWindowDumpFocusMemoForTests,
  type AndroidBlockingDialogObservation,
} from '../window-state.ts';

// One `dumpsys` text answers every window question the daemon asks about a device: which app is
// focused, and whether a blocking system dialog owns the focus. These tests pin the spawn budget
// that follows from that, and the incident-derived parse order (#592) it must not disturb.

const NORMAL_FOCUS_DUMP = [
  '  mCurrentFocus=Window{a1b2c3 u0 com.agentdevice.tester/com.agentdevice.tester.MainActivity}',
  '  mFocusedApp=AppWindowToken{d4e5f6 token=Token{aabbcc ActivityRecord{112233 u0 com.agentdevice.tester/.MainActivity t42}}}',
].join('\n');

// What WMS prints when it names the focused app token but no focused window — the shape an ANR
// title can never appear in.
const APP_TOKEN_ONLY_DUMP = [
  '  mCurrentFocus=null',
  '  mFocusedApp=AppWindowToken{d4e5f6 token=Token{aabbcc ActivityRecord{112233 u0 com.agentdevice.tester/.MainActivity t42}}}',
].join('\n');

const ANR_FOCUS_DUMP =
  '  mCurrentFocus=Window{ffeedd u0 Application Not Responding: com.agentdevice.tester}';

const dumpsysWindowWindows = ['shell', 'dumpsys', 'window', 'windows'].join(' ');
const dumpsysWindow = ['shell', 'dumpsys', 'window'].join(' ');
const dumpsysActivityActivities = ['shell', 'dumpsys', 'activity', 'activities'].join(' ');

function dialogPackage(observation: AndroidBlockingDialogObservation): string | undefined {
  return observation.status === 'dialog' ? observation.focus.package : undefined;
}

beforeEach(() => {
  resetAndroidWindowDumpFocusMemoForTests();
});

test('a focused-window dump answers the blocking-dialog question without a second dumpsys variant', async () => {
  const { calls, observation } = await withFakeAdb(
    (args) => (args.join(' ') === dumpsysWindowWindows ? NORMAL_FOCUS_DUMP : ''),
    async ({ calls, device }) => ({
      calls,
      observation: await getAndroidBlockingDialogObservation(device),
    }),
  );

  assert.equal(observation.status, 'clear');
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows],
  );
});

test('a dump that names only the focused app token does not answer the blocking-dialog question', async () => {
  // `mFocusedApp=AppWindowToken{…}` names the focused APP TOKEN, and an ANR title is a WINDOW
  // title, so that line structurally cannot carry one. Treating it as an answer would suppress the
  // variant that can carry one and report a live ANR as a clear screen (#592).
  const { calls, observation } = await withFakeAdb(
    (args) => (args.join(' ') === dumpsysWindowWindows ? APP_TOKEN_ONLY_DUMP : ANR_FOCUS_DUMP),
    async ({ calls, device }) => ({
      calls,
      observation: await getAndroidBlockingDialogObservation(device),
    }),
  );

  assert.equal(dialogPackage(observation), 'com.agentdevice.tester');
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows, dumpsysWindow],
  );
});

test('a dump nothing answered is reported as unknown, never as a clear screen', async () => {
  const { calls, observation } = await withFakeAdb(
    () => '',
    async ({ calls, device }) => ({
      calls,
      observation: await getAndroidBlockingDialogObservation(device),
    }),
  );

  assert.equal(observation.status, 'unknown');
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows, dumpsysWindow],
  );
});

test('the second dumpsys variant still runs when the first dump shows no focused window', async () => {
  const { calls, observation } = await withFakeAdb(
    (args) => (args.join(' ') === dumpsysWindow ? ANR_FOCUS_DUMP : ''),
    async ({ calls, device }) => ({
      calls,
      observation: await getAndroidBlockingDialogObservation(device),
    }),
  );

  assert.equal(dialogPackage(observation), 'com.agentdevice.tester');
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows, dumpsysWindow],
  );
});

test('a blocking dialog in the first dump is reported from that dump alone', async () => {
  const { calls, observation } = await withFakeAdb(
    (args) => (args.join(' ') === dumpsysWindowWindows ? ANR_FOCUS_DUMP : ''),
    async ({ calls, device }) => ({
      calls,
      observation: await getAndroidBlockingDialogObservation(device),
    }),
  );

  assert.equal(
    observation.status === 'dialog' ? observation.focus.focusedWindow : undefined,
    'Application Not Responding: com.agentdevice.tester',
  );
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows],
  );
});

test('one reader answers the dialog and foreground questions from a single dump', async () => {
  const { calls, observation, state } = await withFakeAdb(
    (args) => (args.join(' ') === dumpsysWindowWindows ? NORMAL_FOCUS_DUMP : ''),
    async ({ calls, device }) => {
      const windowDump = createAndroidWindowDumpReader(device);
      const observation = await getAndroidBlockingDialogObservation(device, windowDump);
      const state = await getAndroidAppState(device, windowDump);
      return { calls, observation, state };
    },
  );

  assert.equal(observation.status, 'clear');
  assert.deepEqual(state, {
    package: 'com.agentdevice.tester',
    activity: 'com.agentdevice.tester.MainActivity',
  });
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows],
  );
});

test('foreground resolution still falls through to the activity dumps behind a system window', async () => {
  const shadeDump = '  mCurrentFocus=Window{a1b2c3 u0 NotificationShade}';
  const { calls, state } = await withFakeAdb(
    (args) =>
      args.join(' ') === dumpsysActivityActivities
        ? '  mResumedActivity: ActivityRecord{99 u0 com.agentdevice.tester/.MainActivity t7}'
        : shadeDump,
    async ({ calls, device }) => ({ calls, state: await getAndroidAppState(device) }),
  );

  assert.deepEqual(state, {
    package: 'com.agentdevice.tester',
    activity: '.MainActivity',
  });
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows, dumpsysWindow, dumpsysActivityActivities],
  );
});

test('a silent window transition never lets an activity dump answer the foreground question first', async () => {
  // WMS prints no focus section at all during a window transition, on the lock screen, and with
  // the screen off. That one sample demotes both window variants — and demotion must stay INSIDE
  // the window tier, because `mCurrentFocus` outranks `mResumedActivity`: an escaped press leaves
  // the app resumed while another package owns the focused window (#592).
  const SETTINGS_FOCUS_DUMP =
    '  mCurrentFocus=Window{a1b2c3 u0 com.android.settings/com.android.settings.Settings}';
  const RESUMED_APP_DUMP =
    '  mResumedActivity: ActivityRecord{99 u0 com.agentdevice.tester/.MainActivity t7}';

  let transition = true;
  const { calls, state } = await withFakeAdb(
    (args) => {
      const command = args.join(' ');
      if (command === dumpsysWindowWindows || command === dumpsysWindow) {
        return transition ? 'WINDOW MANAGER DISPLAY CONTENTS' : SETTINGS_FOCUS_DUMP;
      }
      return RESUMED_APP_DUMP;
    },
    async ({ calls, device }) => {
      await getAndroidAppState(device);
      transition = false;
      return { calls, state: await getAndroidAppState(device) };
    },
  );

  assert.deepEqual(state, {
    package: 'com.android.settings',
    activity: 'com.android.settings.Settings',
  });
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows, dumpsysWindow, dumpsysActivityActivities, dumpsysWindowWindows],
  );
});

test('a variant observed to print no focus section stops being asked first', async () => {
  // Android 16: `dumpsys window windows` has no `mCurrentFocus`, so asking it first buys nothing
  // on every later check.
  const script = (args: string[]) =>
    args.join(' ') === dumpsysWindow ? NORMAL_FOCUS_DUMP : 'WINDOW MANAGER WINDOWS\n  Window #0';

  const { calls } = await withFakeAdb(script, async ({ calls, device }) => {
    await getAndroidBlockingDialogObservation(device);
    await getAndroidBlockingDialogObservation(device);
    await getAndroidBlockingDialogObservation(device);
    return { calls };
  });

  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows, dumpsysWindow, dumpsysWindow, dumpsysWindow],
  );
});

test('a variant that answers only the foreground question is still demoted for the dialog question', async () => {
  // The app-token line answers "which app is foreground" and cannot answer "is a dialog blocking
  // us". A memo that records one observation for both questions keeps paying for a dump that can
  // never answer the question being asked.
  const script = (args: string[]) =>
    args.join(' ') === dumpsysWindowWindows ? APP_TOKEN_ONLY_DUMP : NORMAL_FOCUS_DUMP;

  const { calls } = await withFakeAdb(script, async ({ calls, device }) => {
    await getAndroidBlockingDialogObservation(device);
    await getAndroidBlockingDialogObservation(device);
    return { calls };
  });

  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows, dumpsysWindow, dumpsysWindow],
  );
});

test('a demoted variant is still asked when nothing ahead of it answers', async () => {
  let phase: 'learn' | 'flipped' = 'learn';
  const { calls, observation } = await withFakeAdb(
    (args) => {
      const isWindows = args.join(' ') === dumpsysWindowWindows;
      if (phase === 'learn') return isWindows ? 'WINDOW MANAGER WINDOWS' : NORMAL_FOCUS_DUMP;
      return isWindows ? ANR_FOCUS_DUMP : 'WINDOW MANAGER';
    },
    async ({ calls, device }) => {
      // The first read teaches the memo that `dumpsys window windows` printed no focus section.
      await getAndroidBlockingDialogObservation(device);
      phase = 'flipped';
      return { calls, observation: await getAndroidBlockingDialogObservation(device) };
    },
  );

  assert.equal(dialogPackage(observation), 'com.agentdevice.tester');
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows, dumpsysWindow, dumpsysWindow, dumpsysWindowWindows],
  );
});

test('a variant that has answered once is not demoted by a silent window transition', async () => {
  let transition = false;
  const { calls } = await withFakeAdb(
    (args) => {
      const isWindows = args.join(' ') === dumpsysWindowWindows;
      if (isWindows) return 'WINDOW MANAGER WINDOWS';
      return transition ? 'no focused window mid-transition' : NORMAL_FOCUS_DUMP;
    },
    async ({ calls, device }) => {
      await getAndroidBlockingDialogObservation(device);
      transition = true;
      await getAndroidBlockingDialogObservation(device);
      transition = false;
      await getAndroidBlockingDialogObservation(device);
      return { calls };
    },
  );

  // The transition read asks both variants because neither answered, but it must not cost
  // `dumpsys window` its promotion for every later check.
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows, dumpsysWindow, dumpsysWindow, dumpsysWindowWindows, dumpsysWindow],
  );
});
