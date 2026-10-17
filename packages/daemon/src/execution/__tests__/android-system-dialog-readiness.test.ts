import { beforeEach, expect, test } from 'vitest';
import type {
  AndroidBlockingDialogFocus,
  AndroidObservationAdapter,
} from '@agent-device/contracts/android-observation';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  androidSnapshotPublicationInput,
  createAndroidSnapshotCapture,
} from '@agent-device/platform-android/mechanics';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';

import { makeAndroidSession } from '../../__tests__/support/session-factories.ts';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { ensureAndroidBlockingSystemDialogReady } from '../android-system-dialog.ts';

// A blocking dialog can surface with no adb traffic at all, so nothing a previous command observed
// is evidence about this one. These pin what each readiness phase owes the command it guards.

const APP = 'com.agentdevice.tester';
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

function publishedScreenNodes(): SnapshotNode[] {
  const capture = createAndroidSnapshotCapture(
    {
      nodes: screenNodes,
      analysis: { rawNodeCount: screenNodes.length, maxDepth: 0 },
      androidSnapshot: { backend: 'android-helper' },
      quality: { state: 'healthy', backend: 'android-helper' },
    },
    {
      clickability: {
        kind: 'exact',
        provider: 'android-helper',
        clickableByNodeIndex: new Map(),
      },
    },
  );
  return buildSnapshotState(androidSnapshotPublicationInput(capture), undefined).nodes;
}

function makeObservation(
  dialog: () => AndroidBlockingDialogFocus | undefined,
  options: { unknown?: boolean } = {},
): { observation: AndroidObservationAdapter; calls: string[][] } {
  const calls: string[][] = [];
  const openedApps = new Set<string>();
  let dismissed = false;
  const observation: AndroidObservationAdapter = {
    readAppState: async () => ({}),
    readBlockingDialog: async () => {
      if (options.unknown) return { status: 'unknown' };
      const focus = dismissed ? undefined : dialog();
      return focus ? { status: 'dialog', focus } : { status: 'clear' };
    },
    readAppFocus: async (_device, appBundleId) => dismissed && openedApps.has(appBundleId),
    readSnapshotNodes: async () => (dismissed ? [] : publishedScreenNodes()),
    tap: async (_device, x, y) => {
      calls.push(['shell', 'input', 'tap', String(x), String(y)]);
      dismissed = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    openApp: async (_device, appBundleId) => {
      openedApps.add(appBundleId);
    },
    readScreenSize: async () => ({ width: 1080, height: 1920 }),
    isPermissionPackage: async () => false,
  };
  return { observation, calls };
}

function anrFocus(): AndroidBlockingDialogFocus {
  return {
    package: APP,
    focusedWindow: `Application Not Responding: ${APP}`,
    raw: ANR_FOCUS_DUMP,
  };
}

function systemDialogFocus(): AndroidBlockingDialogFocus {
  return {
    package: 'com.android.systemui',
    focusedWindow: 'Application Not Responding: com.android.systemui',
    raw: SYSTEM_DIALOG_DUMP,
  };
}

test('an ANR that surfaces between two commands is recovered by the next pre-dispatch check', async () => {
  // The previous command's post-dispatch check saw a clear screen and nothing has mutated the
  // device since — but the app blocked on its own. `main` recovers here and lets the command
  // proceed with a warning; a readiness check that answers from that earlier observation instead
  // dispatches this command's tap into the ANR dialog's buttons and then fails it.
  const session = makeAndroidSession('readiness-anr-between', { appBundleId: APP });
  let anr = false;
  const { observation, calls } = makeObservation(() => (anr ? anrFocus() : undefined));
  await ensureAndroidBlockingSystemDialogReady({
    session,
    command: 'tap',
    phase: 'after-command',
    observation,
  });
  anr = true;
  const readiness = await ensureAndroidBlockingSystemDialogReady({
    session,
    command: 'tap',
    phase: 'before-command',
    observation,
  });

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
  const { observation, calls } = makeObservation(anrFocus);

  await expect(
    ensureAndroidBlockingSystemDialogReady({
      session,
      command: 'tap',
      phase: 'before-command',
      observation,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('Android app ANR blocked tap'),
  });

  expect(tapCalls(calls)).toEqual([]);
});

test('a system dialog that surfaces between two commands blocks the next command', async () => {
  const session = makeAndroidSession('readiness-system-between');
  let dialog = false;
  const { observation } = makeObservation(() => (dialog ? systemDialogFocus() : undefined));
  await ensureAndroidBlockingSystemDialogReady({
    session,
    command: 'tap',
    phase: 'after-command',
    observation,
  });
  dialog = true;
  await expect(
    ensureAndroidBlockingSystemDialogReady({
      session,
      command: 'tap',
      phase: 'before-command',
      observation,
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
});

test('an ANR the command itself provoked still fails that command', async () => {
  const session = makeAndroidSession('readiness-anr-after', { appBundleId: APP });
  const { observation, calls } = makeObservation(anrFocus);

  await expect(
    ensureAndroidBlockingSystemDialogReady({
      session,
      command: 'tap',
      phase: 'after-command',
      observation,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('Android app ANR appeared after tap'),
  });
  expect(tapCalls(calls)).toEqual([CLOSE_APP_TAP]);
});

test('a dump that answered nothing is reported as unobserved, not as a clear screen', async () => {
  const session = makeAndroidSession('readiness-unobserved');
  const { observation } = makeObservation(() => undefined, { unknown: true });
  const { readiness, unobserved } = await withDiagnosticsScope({}, async () => {
    const readiness = await ensureAndroidBlockingSystemDialogReady({
      session,
      command: 'tap',
      phase: 'after-command',
      observation,
    });
    return {
      readiness,
      unobserved: countDiagnosticEventsByPhase(['android_blocking_dialog_unobserved']),
    };
  });

  // The command still proceeds — a failed probe has never been a refusal — but nothing about this
  // dump may be carried forward as evidence that the device was clear.
  expect(readiness).toEqual({ status: 'clear' });
  expect(unobserved).toBe(1);
});
