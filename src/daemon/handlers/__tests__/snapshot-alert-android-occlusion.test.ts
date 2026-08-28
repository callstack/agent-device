import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    snapshotAndroid: vi.fn(),
    pressAndroid: vi.fn(),
    backAndroid: vi.fn(),
  };
});

import { pressAndroid, snapshotAndroid } from '@agent-device/platform-android/mechanics';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import { createAndroidInteractor } from '../../../core/interactors/android.ts';
import { makeAndroidSnapshotCapture } from '../../../__tests__/test-utils/android-snapshot-capture.ts';

// R59 moved the alert legs onto the Android interactor, which is where the occlusion reading
// they depend on lives: the legs capture through the same presentation pass `snapshot` publishes,
// and only a presented tree annotates a candidate as covered. The daemon route above them now
// only admits and forwards, so this suite drives the owner directly.
const alertLegs = () => createAndroidInteractor(ANDROID_EMULATOR);

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(snapshotAndroid).mockReset();
  vi.mocked(pressAndroid).mockReset();
});

test('Android alert get does not choose an exactly covered candidate', async () => {
  vi.mocked(snapshotAndroid).mockResolvedValue(coveredAlertCapture() as never);

  const result = await alertLegs().readAlert();

  expect(result).toMatchObject({ action: 'get', alert: null });
  expect(pressAndroid).not.toHaveBeenCalled();
});

test('Android alert accept does not tap an exactly covered candidate', async () => {
  vi.useFakeTimers();
  vi.mocked(snapshotAndroid).mockResolvedValue(coveredAlertCapture() as never);

  const outcome = alertLegs()
    .acceptAlert()
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await vi.advanceTimersByTimeAsync(3_500);
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('alert not found');

  expect(pressAndroid).not.toHaveBeenCalled();
});

function coveredAlertCapture() {
  const nodes = [
    {
      index: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.app.AlertDialog',
      rect: { x: 40, y: 280, width: 310, height: 160 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'android.widget.TextView',
      identifier: 'android:id/alertTitle',
      label: 'Stale confirmation',
      rect: { x: 40, y: 280, width: 310, height: 80 },
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'android.widget.Button',
      identifier: 'android:id/button1',
      label: 'OK',
      hittable: true,
      rect: { x: 40, y: 360, width: 310, height: 80 },
    },
    {
      index: 4,
      parentIndex: 0,
      type: 'android.view.ViewGroup',
    },
    {
      index: 5,
      parentIndex: 4,
      type: 'android.widget.Button',
      label: 'Foreground left',
      hittable: true,
      rect: { x: 40, y: 280, width: 155, height: 160 },
    },
    {
      index: 6,
      parentIndex: 4,
      type: 'android.widget.Button',
      label: 'Foreground right',
      hittable: true,
      rect: { x: 195, y: 280, width: 155, height: 160 },
    },
  ];
  return makeAndroidSnapshotCapture(nodes, {
    occlusionContext: {
      nodes,
      sourceIndexByNodeIndex: new Map(nodes.map((node) => [node.index, node.index])),
      androidSiblingOrderByNodeIndex: new Map([
        [1, { group: 0, order: 1 }],
        [4, { group: 0, order: 2 }],
      ]),
    },
  });
}
