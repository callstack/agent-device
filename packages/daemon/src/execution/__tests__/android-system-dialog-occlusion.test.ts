import { test, expect, vi } from 'vitest';

// #1832: app-ANR recovery reads the daemon presentation, so it must also consume that
// presentation's OCCLUSION result. A covered "Close app" must not be tapped ahead of the visible
// one — the exact disagreement routing through buildSnapshotState exists to remove.
vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return { ...actual, snapshotAndroid: vi.fn(), runAndroidAdb: vi.fn() };
});

import {
  createAndroidSnapshotCapture,
  runAndroidAdb,
  snapshotAndroid,
} from '@agent-device/platform-android/mechanics';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { ensureAndroidBlockingSystemDialogReady } from '../android-system-dialog.ts';
import { androidObservationPolicyFixture as androidObservation } from '../../__tests__/support/android-observation-fixture.ts';
import { makeAndroidSession } from '../../__tests__/support/session-factories.ts';
import { makeAndroidSnapshotCapture } from '@agent-device/platform-android/snapshot-capture-fixtures';

const APP = 'com.example.demo';

/** The session app's ANR is in focus; the Close app taps and the relaunch go through mechanics. */
const appAnrObservation: AndroidObservationAdapter = {
  ...androidObservation,
  readBlockingDialog: async () => ({
    status: 'dialog',
    focus: { package: APP, focusedWindow: `Application Not Responding: ${APP}`, raw: 'ANR' },
  }),
  readAppFocus: async () => true,
  openApp: async () => undefined,
};

async function recoverAppAnr(sessionName: string) {
  return await ensureAndroidBlockingSystemDialogReady({
    session: makeAndroidSession(sessionName, { appBundleId: APP }),
    command: 'press',
    phase: 'before-command',
    observation: appAnrObservation,
  });
}

const SCREEN = { x: 0, y: 0, width: 1080, height: 2400 };

/** A foreground surface drawn over everything below it — what makes the stale dialog unreachable. */
const foregroundSheet = (index: number) => ({
  index,
  type: 'com.google.android.material.bottomsheet.BottomSheetDialog',
  identifier: 'com.example:id/bottom_sheet',
  hittable: true,
  rect: SCREEN,
});

function tappedPoints(): Array<{ x: number; y: number }> {
  return vi
    .mocked(runAndroidAdb)
    .mock.calls.filter((call) => (call[1] as string[]).includes('tap'))
    .map((call) => {
      const args = call[1] as string[];
      const at = args.indexOf('tap');
      return { x: Number(args[at + 1]), y: Number(args[at + 2]) };
    });
}

test('recovery taps the reachable Close app, not a covered one that comes first', async () => {
  vi.mocked(runAndroidAdb).mockReset();
  // The live ANR dialog is on top; a stale "Close app" from an earlier one is still in the tree
  // underneath the sheet. Document order puts the stale button FIRST, which is what the previous
  // hand-rolled presentation selected: the first text match carrying a rect.
  const staleCloseApp = {
    index: 0,
    type: 'Button',
    label: 'Close app',
    identifier: 'android:id/aerr_close',
    hittable: true,
    rect: { x: 40, y: 300, width: 200, height: 80 },
  };
  const sheet = { ...foregroundSheet(1), rect: { x: 0, y: 0, width: 1080, height: 1000 } };
  const dialog = {
    index: 2,
    type: 'TextView',
    label: "App isn't responding",
    rect: { x: 0, y: 1700, width: 1080, height: 60 },
  };
  const visibleCloseApp = {
    index: 3,
    type: 'Button',
    label: 'Close app',
    identifier: 'android:id/aerr_close',
    hittable: true,
    rect: { x: 40, y: 1800, width: 200, height: 80 },
  };
  const visibleWait = {
    index: 4,
    type: 'Button',
    label: 'Wait',
    identifier: 'android:id/aerr_wait',
    hittable: true,
    rect: { x: 40, y: 1900, width: 200, height: 80 },
  };
  vi.mocked(snapshotAndroid)
    .mockResolvedValueOnce(
      makeAndroidSnapshotCapture([
        staleCloseApp,
        sheet,
        dialog,
        visibleCloseApp,
        visibleWait,
      ]) as never,
    )
    .mockResolvedValue(makeAndroidSnapshotCapture([]) as never);
  vi.mocked(runAndroidAdb).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

  const result = await recoverAppAnr('anr-covered-button');

  expect(result.status).toBe('recovered');
  expect(tappedPoints()).toEqual([{ x: 140, y: 1840 }]);
});

test('collectively covered Close app is neither selected nor tapped', async () => {
  vi.mocked(runAndroidAdb).mockReset();
  const nodes = [
    {
      index: 0,
      type: 'android.widget.FrameLayout',
      rect: SCREEN,
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Close app',
      identifier: 'android:id/aerr_close',
      hittable: true,
      rect: { x: 40, y: 300, width: 200, height: 80 },
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'android.view.ViewGroup',
    },
    {
      index: 3,
      parentIndex: 2,
      type: 'android.widget.Button',
      label: 'Foreground left',
      hittable: true,
      rect: { x: 40, y: 300, width: 100, height: 80 },
    },
    {
      index: 4,
      parentIndex: 2,
      type: 'android.widget.Button',
      label: 'Foreground right',
      hittable: true,
      rect: { x: 140, y: 300, width: 100, height: 80 },
    },
    {
      index: 5,
      parentIndex: 0,
      type: 'android.widget.TextView',
      label: "App isn't responding",
      rect: { x: 40, y: 180, width: 320, height: 60 },
    },
    {
      index: 6,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Wait',
      identifier: 'android:id/aerr_wait',
      hittable: true,
      rect: { x: 40, y: 500, width: 200, height: 80 },
    },
  ];
  const capture = makeAndroidSnapshotCapture(nodes, {
    occlusionContext: {
      nodes,
      sourceIndexByNodeIndex: new Map(nodes.map((node) => [node.index, node.index])),
      androidSiblingOrderByNodeIndex: new Map([
        [1, { group: 0, order: 1 }],
        [2, { group: 0, order: 2 }],
        [5, { group: 0, order: 3 }],
        [6, { group: 0, order: 4 }],
      ]),
    },
  });
  vi.mocked(snapshotAndroid)
    .mockResolvedValueOnce(capture as never)
    .mockResolvedValue(makeAndroidSnapshotCapture([]) as never);
  vi.mocked(runAndroidAdb).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

  await expect(recoverAppAnr('anr-collectively-covered-button')).rejects.toMatchObject({
    message: expect.stringContaining('Automatic recovery failed'),
  });
  expect(tappedPoints()).toEqual([]);
});

test('a sparse capture after Close app does not count as the ANR dialog gone', async () => {
  vi.mocked(runAndroidAdb).mockReset();
  vi.mocked(runAndroidAdb).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
  // A presentation that misses its deadline resolves as an empty, truncated, sparse capture.
  const failedPresentation = createAndroidSnapshotCapture(
    {
      nodes: [],
      truncated: true,
      analysis: { rawNodeCount: 0, maxDepth: 0 },
      androidSnapshot: { backend: 'android-helper' },
      quality: { state: 'sparse', backend: 'android-helper' },
    },
    {
      clickability: {
        kind: 'exact',
        provider: 'android-helper',
        clickableByNodeIndex: new Map(),
        longClickableByNodeIndex: new Map(),
      },
    },
  );
  vi.mocked(snapshotAndroid)
    .mockReset()
    .mockResolvedValueOnce(
      makeAndroidSnapshotCapture([
        {
          index: 0,
          type: 'Button',
          label: 'Close app',
          identifier: 'android:id/aerr_close',
          hittable: true,
          rect: { x: 40, y: 1800, width: 200, height: 80 },
        },
        {
          index: 1,
          type: 'Button',
          label: 'Wait',
          identifier: 'android:id/aerr_wait',
          hittable: true,
          rect: { x: 40, y: 1900, width: 200, height: 80 },
        },
      ]) as never,
    )
    .mockResolvedValueOnce(failedPresentation as never)
    .mockResolvedValue(makeAndroidSnapshotCapture([]) as never);
  const capturesAtRelaunch: number[] = [];
  const observation: AndroidObservationAdapter = {
    ...appAnrObservation,
    openApp: async () => {
      capturesAtRelaunch.push(vi.mocked(snapshotAndroid).mock.calls.length);
    },
  };

  vi.useFakeTimers();
  try {
    const recovery = ensureAndroidBlockingSystemDialogReady({
      session: makeAndroidSession('anr-sparse-leave-sample', { appBundleId: APP }),
      command: 'press',
      phase: 'before-command',
      observation,
    });
    await vi.runAllTimersAsync();
    await expect(recovery).resolves.toMatchObject({ status: 'recovered' });
  } finally {
    vi.useRealTimers();
  }

  // The relaunch waited past the sparse sample for the complete one.
  expect(capturesAtRelaunch).toEqual([3]);
});

test('a truncated capture that shows both ANR buttons still reaches the Close app tap', async () => {
  vi.mocked(runAndroidAdb).mockReset();
  vi.mocked(runAndroidAdb).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
  // A node cap in a lower window truncates the whole tree; the dialog's buttons are still there.
  const truncatedWithDialog = createAndroidSnapshotCapture(
    {
      nodes: [
        {
          index: 0,
          type: 'Button',
          label: 'Close app',
          identifier: 'android:id/aerr_close',
          hittable: true,
          rect: { x: 40, y: 1800, width: 200, height: 80 },
        },
        {
          index: 1,
          type: 'Button',
          label: 'Wait',
          identifier: 'android:id/aerr_wait',
          hittable: true,
          rect: { x: 40, y: 1900, width: 200, height: 80 },
        },
      ],
      truncated: true,
      analysis: { rawNodeCount: 2, maxDepth: 0 },
      androidSnapshot: { backend: 'android-helper' },
      quality: { state: 'healthy', backend: 'android-helper' },
    },
    {
      clickability: {
        kind: 'exact',
        provider: 'android-helper',
        clickableByNodeIndex: new Map(),
        longClickableByNodeIndex: new Map(),
      },
    },
  );
  vi.mocked(snapshotAndroid)
    .mockReset()
    .mockResolvedValueOnce(truncatedWithDialog as never)
    .mockResolvedValue(makeAndroidSnapshotCapture([]) as never);

  await expect(recoverAppAnr('anr-truncated-first-capture')).resolves.toMatchObject({
    status: 'recovered',
  });
  expect(tappedPoints()).toEqual([{ x: 140, y: 1840 }]);
});
