import { test, expect, vi } from 'vitest';

// ADR 0014: Android app-ANR recovery is itself device-mutating, so its recovery tap must cross the
// side-effect seam and expire the ref frame.
vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return { ...actual, snapshotAndroid: vi.fn(), runAndroidAdb: vi.fn() };
});

import { runAndroidAdb, snapshotAndroid } from '@agent-device/platform-android/mechanics';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { ensureAndroidBlockingSystemDialogReady } from '../android-system-dialog.ts';
import { androidObservationPolicyFixture as androidObservation } from '../../__tests__/support/android-observation-fixture.ts';
import { makeAndroidSession } from '../../__tests__/support/session-factories.ts';
import { makeAndroidSnapshotCapture } from '@agent-device/platform-android/snapshot-capture-fixtures';
import { refFrameState } from '../../core/ref-frame.ts';

const APP = 'com.example.demo';

test('android app-ANR recovery expires the ref frame before its recovery tap', async () => {
  const closeApp = {
    index: 0,
    type: 'Button',
    label: 'Close app',
    identifier: 'android:id/aerr_close',
    hittable: true,
    rect: { x: 20, y: 200, width: 120, height: 44 },
  };
  // First read: the dialog drives recovery. Next read: the dialog has left after Close app.
  vi.mocked(snapshotAndroid)
    .mockResolvedValueOnce(makeAndroidSnapshotCapture([closeApp]) as never)
    .mockResolvedValue(makeAndroidSnapshotCapture([]) as never);
  vi.mocked(runAndroidAdb).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
  const observation: AndroidObservationAdapter = {
    ...androidObservation,
    readBlockingDialog: async () => ({
      status: 'dialog',
      focus: { package: APP, focusedWindow: `Application Not Responding: ${APP}`, raw: 'ANR' },
    }),
    readAppFocus: async () => true,
    openApp: async () => undefined,
  };

  const session = makeAndroidSession('anr-recovery', { appBundleId: APP });
  expect(refFrameState(session)).toBe('active');

  const result = await ensureAndroidBlockingSystemDialogReady({
    session,
    command: 'press',
    phase: 'before-command',
    observation,
  });

  // The recovery tap was dispatched, and the frame is expired as a result.
  expect(vi.mocked(runAndroidAdb)).toHaveBeenCalled();
  expect(refFrameState(session)).toBe('expired');
  expect(result.status).toBe('recovered');
});
