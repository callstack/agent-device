import { expect, test } from 'vitest';
import { finalizeAndroidRecording } from './finalize.ts';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { createNativeManifest } from './manifest.ts';
import { snapshot } from './completion.ts';

test('writes terminal coordinates before removing a fenced Android artifact', async () => {
  const calls: string[] = [];
  const host = recordingHost({
    writeManifest: async ({ contents }: { contents: string }) => {
      calls.push(JSON.parse(contents).completion ? 'completed' : 'active');
    },
    remove: async (remotePath: string) => {
      calls.push(`remove:${remotePath}`);
      return true;
    },
  });
  const input = recordingInput();
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
  const evidence = createNativeManifest(
    androidRecordingDevice,
    input,
    1,
    [
      {
        index: 1,
        remotePath: '/sdcard/agent-device-recording-1.mp4',
        remotePid: '41',
        remoteStartTime: '7',
      },
    ],
    undefined,
    'local',
  );
  await expect(
    finalizeAndroidRecording({
      host,
      transport,
      evidence,
      manifestPath: '/sdcard/agent-device-recording-active.json',
      recording: snapshot(input, 1),
    }),
  ).resolves.toMatchObject({ status: 'completed' });
  expect(calls).toEqual(['completed', 'remove:/sdcard/agent-device-recording-1.mp4']);
});
