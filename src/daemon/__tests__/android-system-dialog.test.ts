import { test, expect, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';

vi.mock('../../platforms/android/snapshot.ts', () => ({ snapshotAndroid: vi.fn() }));

import { snapshotAndroid } from '../../platforms/android/snapshot.ts';
import { recoverAndroidBlockingSystemDialog as recoverOwnedAndroidBlockingSystemDialog } from '../android-system-dialog.ts';
import { androidObservation } from '../../platform-runtime.ts';

const recoverAndroidBlockingSystemDialog = (
  params: Omit<Parameters<typeof recoverOwnedAndroidBlockingSystemDialog>[0], 'observation'>,
) => recoverOwnedAndroidBlockingSystemDialog({ ...params, observation: androidObservation });

test('inspection failure is carried as a bounded unknown readiness warning', async () => {
  const longErrorMessage = `Android snapshot helper is unavailable:\n\t${'message  '.repeat(60)}`;
  const longHint = `Run pnpm build:android after checking the helper.\n\t${'hint  '.repeat(60)}`;
  vi.mocked(snapshotAndroid).mockRejectedValue(
    new AppError('COMMAND_FAILED', longErrorMessage, {
      hint: longHint,
    }),
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
    expect(result.warning).toMatch(
      /^Android blocking-dialog readiness could not be inspected; the command continued\. Inspection error: .{239}… Hint: .{239}…$/,
    );
    expect(result.warning).not.toMatch(/[\t\r\n]| {2,}/);
  }
});
