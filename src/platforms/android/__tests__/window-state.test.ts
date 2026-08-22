import { test } from 'vitest';
import assert from 'node:assert/strict';
import { withFakeAdb } from '../../../__tests__/test-utils/fake-adb.ts';
import {
  createAndroidWindowDumpReader,
  getAndroidAppState,
  getAndroidBlockingDialogFocus,
} from '../window-state.ts';

// One `dumpsys` text answers every window question the daemon asks about a device: which app is
// focused, and whether a blocking system dialog owns the focus. These tests pin the spawn budget
// that follows from that, and the incident-derived parse order (#1832) it must not disturb.

const NORMAL_FOCUS_DUMP = [
  '  mCurrentFocus=Window{a1b2c3 u0 com.agentdevice.tester/com.agentdevice.tester.MainActivity}',
  '  mFocusedApp=AppWindowToken{d4e5f6 token=Token{aabbcc ActivityRecord{112233 u0 com.agentdevice.tester/.MainActivity t42}}}',
].join('\n');

const ANR_FOCUS_DUMP =
  '  mCurrentFocus=Window{ffeedd u0 Application Not Responding: com.agentdevice.tester}';

const dumpsysWindowWindows = ['shell', 'dumpsys', 'window', 'windows'].join(' ');
const dumpsysWindow = ['shell', 'dumpsys', 'window'].join(' ');

test('a focused-window dump answers the blocking-dialog question without a second dumpsys variant', async () => {
  const { calls, focus } = await withFakeAdb(
    (args) => (args.join(' ') === dumpsysWindowWindows ? NORMAL_FOCUS_DUMP : ''),
    async ({ calls, device }) => ({
      calls,
      focus: await getAndroidBlockingDialogFocus(device),
    }),
  );

  assert.equal(focus, null);
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows],
  );
});

test('the second dumpsys variant still runs when the first dump shows no focused window', async () => {
  const { calls, focus } = await withFakeAdb(
    (args) => (args.join(' ') === dumpsysWindow ? ANR_FOCUS_DUMP : ''),
    async ({ calls, device }) => ({
      calls,
      focus: await getAndroidBlockingDialogFocus(device),
    }),
  );

  assert.equal(focus?.package, 'com.agentdevice.tester');
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows, dumpsysWindow],
  );
});

test('a blocking dialog in the first dump is reported from that dump alone', async () => {
  const { calls, focus } = await withFakeAdb(
    (args) => (args.join(' ') === dumpsysWindowWindows ? ANR_FOCUS_DUMP : ''),
    async ({ calls, device }) => ({
      calls,
      focus: await getAndroidBlockingDialogFocus(device),
    }),
  );

  assert.equal(focus?.focusedWindow, 'Application Not Responding: com.agentdevice.tester');
  assert.deepEqual(
    calls.map((args) => args.join(' ')),
    [dumpsysWindowWindows],
  );
});

test('one reader answers the dialog and foreground questions from a single dump', async () => {
  const { calls, focus, state } = await withFakeAdb(
    (args) => (args.join(' ') === dumpsysWindowWindows ? NORMAL_FOCUS_DUMP : ''),
    async ({ calls, device }) => {
      const windowDump = createAndroidWindowDumpReader(device);
      const focus = await getAndroidBlockingDialogFocus(device, windowDump);
      const state = await getAndroidAppState(device, windowDump);
      return { calls, focus, state };
    },
  );

  assert.equal(focus, null);
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
      args.join(' ') === 'shell dumpsys activity activities'
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
    [dumpsysWindowWindows, dumpsysWindow, 'shell dumpsys activity activities'],
  );
});
