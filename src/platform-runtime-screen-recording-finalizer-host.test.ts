import { expect, test, vi } from 'vitest';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';

const video = vi.hoisted(() => ({
  stable: vi.fn(async () => {}),
  playable: vi.fn(async () => {}),
  isPlayable: vi.fn(async () => true),
}));
const telemetry = vi.hoisted(() => vi.fn(() => '/tmp/capture.telemetry.json'));
vi.mock('./utils/video.ts', () => ({
  waitForStableFile: video.stable,
  waitForPlayableVideo: video.playable,
  isPlayableVideo: video.isPlayable,
}));
vi.mock('./recording/telemetry.ts', () => ({ persistRecordingTelemetry: telemetry }));
vi.mock('./recording/overlay.ts', () => ({
  getRecordingOverlaySupportWarning: () => undefined,
  overlayRecordingTouches: vi.fn(async () => {}),
  trimRecordingStart: vi.fn(async () => {}),
}));

test('requires stable playable media before publishing finalization telemetry', async () => {
  const result = await createScreenRecordingFinalizer().complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: false,
    gestureEvents: [],
    targetLabel: 'test recording',
  });

  expect(video.stable).toHaveBeenCalledWith('/tmp/capture.mp4');
  expect(video.playable).toHaveBeenCalledWith('/tmp/capture.mp4');
  expect(result).toEqual({ telemetryPath: '/tmp/capture.telemetry.json' });
});
