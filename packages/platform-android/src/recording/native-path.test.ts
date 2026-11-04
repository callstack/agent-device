import { expect, test } from 'vitest';
import { recordingArtifactPath, recordingMarkerPath } from './native-path.ts';

const generation = {
  deviceId: 'device',
  sessionId: 'session',
  claimToken: 'claim',
  fence: { token: 'fence', generation: 3 },
};

test('isolates marker and artifact names by the complete recording generation', () => {
  const marker = recordingMarkerPath('/sdcard', generation);
  const artifact = recordingArtifactPath('/sdcard', generation, 123);
  expect(marker).toMatch(/^\/sdcard\/agent-device-recording-v2-[a-f0-9]{64}\.json$/);
  expect(artifact).toMatch(/^\/sdcard\/agent-device-recording-v2-[a-f0-9]{64}-123\.mp4$/);
  for (const different of [
    { ...generation, deviceId: 'other' },
    { ...generation, sessionId: 'other' },
    { ...generation, claimToken: 'other' },
    { ...generation, fence: { ...generation.fence, token: 'other' } },
    { ...generation, fence: { ...generation.fence, generation: 4 } },
  ]) {
    expect(recordingMarkerPath('/sdcard', different)).not.toBe(marker);
    expect(recordingArtifactPath('/sdcard', different, 123)).not.toBe(artifact);
  }
  expect(marker).not.toBe('/sdcard/agent-device-recording-active.json');
  expect(artifact).not.toBe('/sdcard/agent-device-recording-123.mp4');
});
