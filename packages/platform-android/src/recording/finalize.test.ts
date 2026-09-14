import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mp4Atom, mp4MovieHeader } from '@agent-device/capture-kit/recording-mp4-fixtures';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';
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
      startedAtMs: 1,
    }),
  ).resolves.toMatchObject({ status: 'completed' });
  expect(calls).toEqual(['completed', 'remove:/sdcard/agent-device-recording-1.mp4']);
});

test('measures a pulled MP4 against the window the host bracketed around the recorder', async () => {
  const directory = mkdtempForTestSync('agent-device-android-finalize-');
  const calls: string[] = [];
  const host = recordingHost({
    stop: async () => {
      calls.push('stop');
      return 'stopped' as const;
    },
    isRunning: async () => false,
    pullPlayable: async ({ outputPath }: { outputPath: string }) => {
      calls.push('pull');
      fs.writeFileSync(
        outputPath,
        Buffer.concat([
          mp4Atom('mdat', Buffer.alloc(8)),
          mp4Atom(
            'moov',
            mp4Atom('mvhd', mp4MovieHeader({ version: 0, timescale: 1_000, duration: 7_000 })),
          ),
        ]),
      );
      return { stdout: '', stderr: '', exitCode: 0, playable: true };
    },
  });
  const input = { ...recordingInput(), outputPath: path.join(directory, 'capture.mp4') };
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
  const outcome = await finalizeAndroidRecording({
    host,
    transport,
    evidence: createNativeManifest(
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
    ),
    manifestPath: '/sdcard/agent-device-recording-active.json',
    recording: snapshot(input, 1),
    startedAtMs: Date.now() - 16_000,
  });

  expect(calls).toEqual(['stop', 'pull']);
  expect(outcome.result.capturedDurationMs).toBe(7_000);
  expect(outcome.result.warning).toMatch(/it covers 7\.0s of the 16\.\ds recording window\./);
});
