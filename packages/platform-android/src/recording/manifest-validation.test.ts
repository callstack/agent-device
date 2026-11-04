import { expect, test } from 'vitest';
import { androidRecordingDevice, recordingInput } from './fixtures.ts';
import { createCompletedNativeManifest, createNativeManifest } from './manifest.ts';
import { recordingArtifactPath, recordingMarkerPath } from './native-path.ts';
import { isValidAndroidRecordingDescriptor, isValidNativeManifest } from './manifest-validation.ts';

const generation = {
  deviceId: androidRecordingDevice.id,
  sessionId: recordingInput().sessionId,
  claimToken: recordingInput().claimToken,
  fence: recordingInput().fence,
};
test('validates descriptor structure independently of descriptor decoding', () => {
  expect(
    isValidAndroidRecordingDescriptor({
      backend: 'adb-screenrecord-v2-admitted',
      manifestPath: recordingMarkerPath('/sdcard', generation),
      outputPath: '/tmp/capture.mp4',
      scope: 'device',
      showTouches: true,
      recordOnlySession: false,
      transportMode: 'local',
    }),
  ).toBe(true);
  expect(
    isValidAndroidRecordingDescriptor({
      backend: 'adb-screenrecord-v2-admitted',
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
        remotePath: recordingArtifactPath('/sdcard', generation, 1),
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

test('accepts a measured clip length in terminal evidence and refuses an uncountable one', () => {
  const input = recordingInput();
  const active = createNativeManifest(
    androidRecordingDevice,
    input,
    1,
    [
      {
        index: 1,
        remotePath: recordingArtifactPath('/sdcard', generation, 1),
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
    capturedDurationMs: 7_000,
    scope: input.scope,
    showTouches: input.showTouches,
    recordOnlySession: input.recordOnlySession,
  });
  expect(isValidNativeManifest(complete)).toBe(true);
  for (const capturedDurationMs of ['7000', Number.NaN]) {
    expect(
      isValidNativeManifest({
        ...complete,
        completion: { ...complete.completion!, capturedDurationMs },
      }),
    ).toBe(false);
  }
});
