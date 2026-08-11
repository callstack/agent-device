import { expect, test } from 'vitest';
import { cleanupVerifiedAndroidEvidence } from './cleanup.ts';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { createNativeManifest } from './manifest.ts';

test('attempts every fenced native chunk before retaining cleanup evidence', async () => {
  const attempts: string[] = [];
  const host = recordingHost({
    stop: async ({ pid }: { pid: string }) => {
      attempts.push(`stop:${pid}`);
      if (pid === '41') throw new Error('stop failed');
      return 'stopped' as const;
    },
    inspect: async () => 'missing' as const,
    remove: async (remotePath: string) => {
      attempts.push(`remove:${remotePath}`);
      return true;
    },
  });
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
  const evidence = createNativeManifest(
    androidRecordingDevice,
    recordingInput(),
    1,
    [
      {
        index: 1,
        remotePath: '/sdcard/agent-device-recording-1.mp4',
        remotePid: '41',
        remoteStartTime: '7',
      },
      {
        index: 2,
        remotePath: '/sdcard/agent-device-recording-2.mp4',
        remotePid: '42',
        remoteStartTime: '8',
      },
    ],
    undefined,
    'local',
  );
  await expect(
    cleanupVerifiedAndroidEvidence(
      transport,
      evidence,
      '/sdcard/agent-device-recording-active.json',
    ),
  ).resolves.toMatchObject({ status: 'cleanup-pending' });
  expect(attempts).toContain('stop:42');
  expect(attempts).toContain('stop:41');
});
