import { beforeEach, expect, test, vi } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

/**
 * Recovery reads the daemon presentation, and Android publication derives covered state from the
 * acquisition evidence the capture envelope carries (#1981). The fake capture is therefore built by
 * the production constructor: a bare `{ nodes }` throws inside publication, and recovery would then
 * report "recovery failed" for a fixture reason rather than a device one.
 */
vi.mock('../../platforms/android/snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/snapshot.ts')>();
  const { makeAndroidSnapshotCapture } =
    await import('../../__tests__/test-utils/android-snapshot-capture.ts');
  return {
    ...actual,
    snapshotAndroid: vi.fn(async () => makeAndroidSnapshotCapture(screenNodes)),
  };
});

vi.mock('../../platforms/android/app-lifecycle.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/app-lifecycle.ts')>();
  return { ...actual, openAndroidApp: vi.fn(async () => {}) };
});

import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { withFakeAdb, type FakeAdbScript } from '../../__tests__/test-utils/fake-adb.ts';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { ensureAndroidBlockingSystemDialogReady as ensureOwnedAndroidBlockingSystemDialogReady } from '../android-system-dialog.ts';
import { androidObservation } from '../../platform-runtime.ts';

const ensureAndroidBlockingSystemDialogReady = (
  params: Omit<Parameters<typeof ensureOwnedAndroidBlockingSystemDialogReady>[0], 'observation'>,
) => ensureOwnedAndroidBlockingSystemDialogReady({ ...params, observation: androidObservation });

// A blocking dialog can surface with no adb traffic at all, so nothing a previous command observed
// is evidence about this one. These pin what each readiness phase owes the command it guards.

const APP = 'com.agentdevice.tester';
const NORMAL_FOCUS_DUMP = `  mCurrentFocus=Window{a1b2c3 u0 ${APP}/${APP}.MainActivity}`;
const ANR_FOCUS_DUMP = `  mCurrentFocus=Window{ffeedd u0 Application Not Responding: ${APP}}`;
const SYSTEM_DIALOG_DUMP =
  '  mCurrentFocus=Window{ffeedd u0 Application Not Responding: com.android.systemui}';
const CLOSE_APP_RECT = { x: 100, y: 600, width: 220, height: 80 };
const CLOSE_APP_TAP = ['shell', 'input', 'tap', '210', '640'];

/** What the mocked capture publishes: the screen the case under test is recovering from. */
let screenNodes: RawSnapshotNode[];

beforeEach(() => {
  screenNodes = anrDialogNodes();
});

function anrDialogNodes(): RawSnapshotNode[] {
  return [
    {
      index: 0,
      type: 'android.widget.TextView',
      label: `${APP} isn't responding`,
      rect: { x: 50, y: 400, width: 500, height: 80 },
    },
    {
      index: 1,
      type: 'android.widget.Button',
      label: 'Close app',
      rect: CLOSE_APP_RECT,
    },
  ];
}

/**
 * The same dialog with a foreground sheet drawn over it: the "Close app" is in the tree but nothing
 * a user could touch. #1832 — recovery acts on what is reachable, never on raw text.
 */
function coveredCloseAppNodes(): RawSnapshotNode[] {
  return [
    ...anrDialogNodes(),
    {
      index: 2,
      type: 'com.google.android.material.bottomsheet.BottomSheetDialog',
      identifier: 'com.example:id/bottom_sheet',
      hittable: true,
      rect: { x: 0, y: 0, width: 1080, height: 2400 },
    },
  ];
}

function tapCalls(calls: string[][]): string[][] {
  return calls.filter((call) => call[1] === 'input' && call[2] === 'tap');
}

/**
 * A device whose focused window is `dialog` until recovery taps "Close app", and the app after
 * that — the tap is what dismisses the dialog on a real device too.
 */
function deviceShowing(dialog: () => string | null): FakeAdbScript {
  let dismissed = false;
  return (args) => {
    if (args[1] === 'input' && args[2] === 'tap') {
      dismissed = true;
      return '';
    }
    if (args[1] !== 'dumpsys') return '';
    const focus = dismissed ? null : dialog();
    return focus ?? NORMAL_FOCUS_DUMP;
  };
}

test('an ANR that surfaces between two commands is recovered by the next pre-dispatch check', async () => {
  // The previous command's post-dispatch check saw a clear screen and nothing has mutated the
  // device since — but the app blocked on its own. `main` recovers here and lets the command
  // proceed with a warning; a readiness check that answers from that earlier observation instead
  // dispatches this command's tap into the ANR dialog's buttons and then fails it.
  const session = makeAndroidSession('readiness-anr-between', { appBundleId: APP });
  let anr = false;

  const { readiness, calls } = await withFakeAdb(
    deviceShowing(() => (anr ? ANR_FOCUS_DUMP : null)),
    async ({ device, calls }) => {
      session.device = device;
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'after-command',
      });
      anr = true;
      const readiness = await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'before-command',
      });
      return { readiness, calls };
    },
  );

  expect(readiness).toEqual({
    status: 'recovered',
    warning: `Recovered Android app ANR before tap: closed and relaunched ${APP}.`,
  });
  // Recovering means the dialog was actually dismissed on the device, so the reported status is
  // pinned to the tap that did it rather than to the status value alone.
  expect(tapCalls(calls)).toEqual([CLOSE_APP_TAP]);
});

test('an ANR whose Close app is covered is not tapped, and recovery reports failure', async () => {
  // #1832: recovery reads the presentation's occlusion result, so a "Close app" that a foreground
  // surface covers is unreachable. Tapping it anyway would land the tap on whatever is on top.
  const session = makeAndroidSession('readiness-anr-covered', { appBundleId: APP });
  screenNodes = coveredCloseAppNodes();

  const { calls } = await withFakeAdb(
    deviceShowing(() => ANR_FOCUS_DUMP),
    async ({ device, calls }) => {
      session.device = device;
      await expect(
        ensureAndroidBlockingSystemDialogReady({
          session,
          command: 'tap',
          phase: 'before-command',
        }),
      ).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        message: expect.stringContaining('Android app ANR blocked tap'),
      });
      return { calls };
    },
  );

  expect(tapCalls(calls)).toEqual([]);
});

test('a system dialog that surfaces between two commands blocks the next command', async () => {
  const session = makeAndroidSession('readiness-system-between');
  let dialog = false;

  await withFakeAdb(
    deviceShowing(() => (dialog ? SYSTEM_DIALOG_DUMP : null)),
    async ({ device }) => {
      session.device = device;
      await ensureAndroidBlockingSystemDialogReady({
        session,
        command: 'tap',
        phase: 'after-command',
      });
      dialog = true;
      await expect(
        ensureAndroidBlockingSystemDialogReady({
          session,
          command: 'tap',
          phase: 'before-command',
        }),
      ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    },
  );
});

test('an ANR the command itself provoked still fails that command', async () => {
  const session = makeAndroidSession('readiness-anr-after', { appBundleId: APP });

  await withFakeAdb(
    deviceShowing(() => ANR_FOCUS_DUMP),
    async ({ device }) => {
      session.device = device;
      await expect(
        ensureAndroidBlockingSystemDialogReady({
          session,
          command: 'tap',
          phase: 'after-command',
        }),
      ).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        message: expect.stringContaining('Android app ANR appeared after tap'),
      });
    },
  );
});

test('a dump that answered nothing is reported as unobserved, not as a clear screen', async () => {
  const session = makeAndroidSession('readiness-unobserved');

  const { readiness, unobserved } = await withDiagnosticsScope({}, async () =>
    withFakeAdb(
      () => ({ exitCode: 1, stdout: '', stderr: 'device offline' }),
      async ({ device }) => {
        session.device = device;
        const readiness = await ensureAndroidBlockingSystemDialogReady({
          session,
          command: 'tap',
          phase: 'after-command',
        });
        return {
          readiness,
          unobserved: countDiagnosticEventsByPhase(['android_blocking_dialog_unobserved']),
        };
      },
    ),
  );

  // The command still proceeds — a failed probe has never been a refusal — but nothing about this
  // dump may be carried forward as evidence that the device was clear.
  expect(readiness).toEqual({ status: 'clear' });
  expect(unobserved).toBe(1);
});
