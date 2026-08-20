import { test, expect, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';

vi.mock('../../platforms/android/snapshot.ts', () => ({ snapshotAndroid: vi.fn() }));

import { snapshotAndroid } from '../../platforms/android/snapshot.ts';
import { recoverAndroidBlockingSystemDialog } from '../android-system-dialog.ts';

test('inspection failure is carried as a bounded unknown readiness warning', async () => {
  vi.mocked(snapshotAndroid).mockRejectedValue(
    new AppError(
      'COMMAND_FAILED',
      'Android snapshot helper is unavailable: helper artifact is missing',
      {
        hint: 'Run `pnpm build:android` to build the Android snapshot helper for this source checkout.',
      },
    ),
  );
  const session = makeAndroidSession('inspection-warning');
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'adb screenrecord',
    outPath: '/tmp/inspection-warning.mp4',
    startedAt: 0,
  });

  const result = await recoverAndroidBlockingSystemDialog({ session });

  expect(result).toMatchObject({
    status: 'unknown',
    reason: 'inspection-failed',
    warning: expect.stringContaining('Android blocking-dialog readiness could not be inspected'),
  });
  if (result.status === 'unknown') {
    expect(result.warning).toMatch(/command continued/i);
    expect(result.warning).toContain('pnpm build:android');
    expect(result.warning.length).toBeLessThan(800);
  }
});
