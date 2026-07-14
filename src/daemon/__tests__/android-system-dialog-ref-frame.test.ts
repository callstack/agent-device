import { test, expect, vi } from 'vitest';

// ADR 0014: Android blocking-dialog recovery is itself device-mutating, so its
// recovery tap must cross the side-effect seam and expire the ref frame.
vi.mock('../../platforms/android/snapshot.ts', () => ({ snapshotAndroid: vi.fn() }));
vi.mock('../../platforms/android/adb.ts', () => ({ runAndroidAdb: vi.fn() }));

import { snapshotAndroid } from '../../platforms/android/snapshot.ts';
import { runAndroidAdb } from '../../platforms/android/adb.ts';
import { recoverAndroidBlockingSystemDialog } from '../android-system-dialog.ts';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';

test('android blocking-dialog recovery expires the ref frame before its recovery tap', async () => {
  const dialog = {
    index: 0,
    type: 'TextView',
    label: "App isn't responding",
    rect: { x: 0, y: 0, width: 300, height: 60 },
  };
  const closeApp = {
    index: 1,
    type: 'Button',
    label: 'Close app',
    hittable: true,
    rect: { x: 20, y: 200, width: 120, height: 44 },
  };
  // First read: the blocking dialog is present (drives recovery). Post-tap poll:
  // the dialog is gone, so recovery completes without sleeping through retries.
  vi.mocked(snapshotAndroid)
    .mockResolvedValueOnce({ nodes: [dialog, closeApp] } as never)
    .mockResolvedValue({ nodes: [] } as never);
  vi.mocked(runAndroidAdb).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

  const session = makeAndroidSession('anr-recovery');
  session.recording = { outPath: '/tmp/anr.mp4', startedAt: 0 } as never;
  expect(session.refFrameState).toBeUndefined(); // active

  const result = await recoverAndroidBlockingSystemDialog({ session });

  // The recovery tap was dispatched, and the frame is expired as a result.
  expect(vi.mocked(runAndroidAdb)).toHaveBeenCalled();
  expect(session.refFrameState).toBe('expired');
  expect(result.status).not.toBe('absent');
});
