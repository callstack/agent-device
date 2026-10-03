import { test, expect, vi } from 'vitest';

// #1832: blocking-dialog recovery reads the daemon presentation, so it must also consume that
// presentation's OCCLUSION result. A stale "App isn't responding" surface left under the foreground
// one must not trigger recovery, and a covered "Close app" must not be tapped ahead of the visible
// one — the exact disagreement routing through buildSnapshotState exists to remove.
vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return { ...actual, snapshotAndroid: vi.fn(), runAndroidAdb: vi.fn() };
});

import { runAndroidAdb, snapshotAndroid } from '@agent-device/platform-android/mechanics';
import { recoverAndroidBlockingSystemDialog as recoverOwnedAndroidBlockingSystemDialog } from '../android-system-dialog.ts';
import { androidObservation } from '../../platform-runtime.ts';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';
import { makeAndroidSnapshotCapture } from '../../__tests__/test-utils/android-snapshot-capture.ts';

const recoverAndroidBlockingSystemDialog = (
  params: Omit<Parameters<typeof recoverOwnedAndroidBlockingSystemDialog>[0], 'observation'>,
) => recoverOwnedAndroidBlockingSystemDialog({ ...params, observation: androidObservation });

const SCREEN = { x: 0, y: 0, width: 1080, height: 2400 };

/** A foreground surface drawn over everything below it — what makes the stale dialog unreachable. */
const foregroundSheet = (index: number) => ({
  index,
  type: 'com.google.android.material.bottomsheet.BottomSheetDialog',
  identifier: 'com.example:id/bottom_sheet',
  hittable: true,
  rect: SCREEN,
});

function recordingSession(name: string) {
  const session = makeAndroidSession(name);
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'adb screenrecord',
    outPath: '/tmp/anr.mp4',
    startedAt: 0,
  });
  return session;
}

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
    hittable: true,
    rect: { x: 40, y: 1800, width: 200, height: 80 },
  };
  vi.mocked(snapshotAndroid)
    .mockResolvedValueOnce(
      makeAndroidSnapshotCapture([staleCloseApp, sheet, dialog, visibleCloseApp]) as never,
    )
    .mockResolvedValue(makeAndroidSnapshotCapture([]) as never);
  vi.mocked(runAndroidAdb).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

  const result = await recoverAndroidBlockingSystemDialog({
    session: recordingSession('anr-covered-button'),
  });

  expect(result.status).toBe('recovered');
  expect(tappedPoints()).toEqual([{ x: 140, y: 1840 }]);
});

test('a fully covered dialog does not trigger recovery', async () => {
  vi.mocked(runAndroidAdb).mockReset();
  const staleDialog = {
    index: 0,
    type: 'TextView',
    label: "App isn't responding",
    hittable: true,
    rect: { x: 0, y: 100, width: 1080, height: 60 },
  };
  const staleCloseApp = {
    index: 1,
    type: 'Button',
    label: 'Close app',
    hittable: true,
    rect: { x: 40, y: 300, width: 200, height: 80 },
  };
  vi.mocked(snapshotAndroid).mockResolvedValue(
    makeAndroidSnapshotCapture([staleDialog, staleCloseApp, foregroundSheet(2)]) as never,
  );
  vi.mocked(runAndroidAdb).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

  const result = await recoverAndroidBlockingSystemDialog({
    session: recordingSession('anr-covered-dialog'),
  });

  expect(result.status).toBe('absent');
  expect(tappedPoints()).toEqual([]);
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
  ];
  const capture = makeAndroidSnapshotCapture(nodes, {
    occlusionContext: {
      nodes,
      sourceIndexByNodeIndex: new Map(nodes.map((node) => [node.index, node.index])),
      androidSiblingOrderByNodeIndex: new Map([
        [1, { group: 0, order: 1 }],
        [2, { group: 0, order: 2 }],
        [5, { group: 0, order: 3 }],
      ]),
    },
  });
  vi.mocked(snapshotAndroid)
    .mockResolvedValueOnce(capture as never)
    .mockResolvedValue(makeAndroidSnapshotCapture([]) as never);
  vi.mocked(runAndroidAdb).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

  const result = await recoverAndroidBlockingSystemDialog({
    session: recordingSession('anr-collectively-covered-button'),
  });

  expect(result.status).toBe('absent');
  expect(tappedPoints()).toEqual([]);
});
