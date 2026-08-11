import { expect, test } from 'vitest';
import { androidRecordingDevice, recordingInput } from './fixtures.ts';
import { createCompletedNativeManifest, createNativeManifest } from './manifest.ts';
import { isValidAndroidRecordingDescriptor, isValidNativeManifest } from './manifest-validation.ts';

test('validates descriptor structure independently of descriptor decoding', () => {
  expect(
    isValidAndroidRecordingDescriptor({
      backend: 'adb-screenrecord',
      manifestPath: '/sdcard/agent-device-recording-active.json',
      outputPath: '/tmp/capture.mp4',
      scope: 'device',
      showTouches: true,
      recordOnlySession: false,
      transportMode: 'local',
    }),
  ).toBe(true);
  expect(
    isValidAndroidRecordingDescriptor({
      backend: 'adb-screenrecord',
      manifestPath: '/tmp/active.json',
      outputPath: '/tmp/capture.mp4',
      scope: 'device',
      showTouches: true,
      recordOnlySession: false,
      transportMode: 'local',
    }),
  ).toBe(false);
});

test('rejects terminal evidence whose result coordinates diverge from its manifest', () => {
  const input = recordingInput();
  const active = createNativeManifest(
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
  const complete = createCompletedNativeManifest(active, {
    backend: 'adb screenrecord',
    outPath: input.outputPath,
    startedAt: 1,
    completedAt: 2,
    scope: input.scope,
    showTouches: input.showTouches,
    recordOnlySession: input.recordOnlySession,
  });
  expect(isValidNativeManifest(complete)).toBe(true);
  expect(
    isValidNativeManifest({
      ...complete,
      completion: { ...complete.completion!, outPath: '/tmp/other.mp4' },
    }),
  ).toBe(false);
});
