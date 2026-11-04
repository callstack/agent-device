import { expect, test } from 'vitest';
import { androidRecordingDescriptorFixture } from '@agent-device/test-kit';
import { recordingArtifactPath, recordingMarkerPath } from './native-path.ts';
import {
  androidScreenRecordingDescriptorCodec,
  createNativeManifest,
  decodeNativeManifest,
  nativeManifestMatchesEnvelope,
} from './manifest.ts';

const device = {
  platform: 'android' as const,
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator' as const,
  target: 'mobile' as const,
  booted: true,
};

const generation = {
  deviceId: device.id,
  sessionId: 'session-1',
  fence: { token: 'fence-1', generation: 2 },
};
test('decodes only complete, ordered Android native recording evidence', () => {
  const manifest = createNativeManifest(
    device,
    {
      sessionId: 'session-1',
      outputPath: '/tmp/capture.mp4',
      scope: 'device',
      showTouches: true,
      hideTouchesRequested: false,
      recordOnlySession: false,
      fence: { token: 'fence-1', generation: 2 },
    },
    100,
    [
      {
        index: 1,
        remotePath: recordingArtifactPath('/sdcard', generation, 100),
        remotePid: '42',
        remoteStartTime: '1',
      },
    ],
  );
  expect(decodeNativeManifest(JSON.stringify(manifest))).toEqual(manifest);
  expect(
    decodeNativeManifest(
      JSON.stringify({ ...manifest, chunks: [{ ...manifest.chunks[0], remotePid: 'pid' }] }),
    ),
  ).toBeUndefined();
  expect(
    decodeNativeManifest(
      JSON.stringify({ ...manifest, chunks: [{ ...manifest.chunks[0], index: 2 }] }),
    ),
  ).toBeUndefined();
});

test('accepts only a durable Android manifest path in the descriptor', () => {
  expect(
    androidScreenRecordingDescriptorCodec.decode({
      ...androidRecordingDescriptorFixture,
      backend: 'adb-screenrecord-v2',
      manifestPath: recordingMarkerPath('/sdcard', generation),
    }),
  ).toMatchObject({ status: 'decoded' });
  expect(
    androidScreenRecordingDescriptorCodec.decode({
      backend: 'adb-screenrecord',
      manifestPath: '/tmp/agent-device-recording-active.json',
    }),
  ).toMatchObject({ status: 'invalid' });
});

test('requires the device, session, and fence identity carried by the durable envelope', () => {
  const manifest = createNativeManifest(
    device,
    {
      sessionId: 'session-1',
      outputPath: '/tmp/capture.mp4',
      scope: 'device',
      showTouches: true,
      hideTouchesRequested: false,
      recordOnlySession: false,
      fence: { token: 'fence-1', generation: 2 },
    },
    100,
    [
      {
        index: 1,
        remotePath: recordingArtifactPath('/sdcard', generation, 100),
        remotePid: '42',
        remoteStartTime: '1',
      },
    ],
  );
  const envelope = {
    sessionId: 'session-1',
    device: { id: device.id },
    fence: { token: 'fence-1', generation: 2 },
  };
  expect(nativeManifestMatchesEnvelope(manifest, device, envelope as never)).toBe(true);
  expect(
    nativeManifestMatchesEnvelope(manifest, device, {
      ...envelope,
      device: { id: 'another-device' },
    } as never),
  ).toBe(false);
});

test('rejects legacy descriptor names and paths rather than adopting their marker', () => {
  expect(
    androidScreenRecordingDescriptorCodec.decode(androidRecordingDescriptorFixture),
  ).toMatchObject({ status: 'invalid' });
  expect(androidScreenRecordingDescriptorCodec.version).toBe(2);
});
