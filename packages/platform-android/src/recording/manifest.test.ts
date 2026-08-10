import { expect, test } from 'vitest';
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
        remotePath: '/sdcard/agent-device-recording-100.mp4',
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
      backend: 'adb-screenrecord',
      manifestPath: '/data/local/tmp/agent-device-recording-active.json',
      outputPath: '/tmp/capture.mp4',
      scope: 'device',
      showTouches: true,
      recordOnlySession: false,
      transportMode: 'local',
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
        remotePath: '/sdcard/agent-device-recording-100.mp4',
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
