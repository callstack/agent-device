import { expect, test, vi } from 'vitest';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';

const video = vi.hoisted(() => ({
  stable: vi.fn(async () => {}),
  playable: vi.fn(async () => {}),
  isPlayable: vi.fn(async () => true),
  container: vi.fn(async () => true),
}));
const telemetry = vi.hoisted(() => vi.fn(() => '/tmp/capture.telemetry.json'));
vi.mock('@agent-device/capture-kit/recording-video', () => ({
  waitForStableFile: video.stable,
  waitForPlayableVideo: video.playable,
  isPlayableVideo: video.isPlayable,
  hasVideoContainer: video.container,
}));
vi.mock('@agent-device/capture-kit/recording-telemetry', () => ({
  persistRecordingTelemetry: telemetry,
}));
vi.mock('@agent-device/capture-kit/recording-overlay', () => ({
  getRecordingOverlaySupportWarning: () => undefined,
  overlayRecordingTouches: vi.fn(async () => {}),
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

test('names the retry and the escape for a recording that never became playable', async () => {
  video.isPlayable.mockResolvedValueOnce(false);

  await expect(
    createScreenRecordingFinalizer().complete({
      outputPath: '/tmp/capture.mp4',
      showTouches: false,
      gestureEvents: [],
      targetLabel: 'test recording',
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('was not finalized into a playable video'),
    details: {
      reason: 'recording-output-unplayable',
      retriable: true,
      hint: expect.stringContaining('close this session'),
    },
  });
});

test('sniffs a collected copy without spawning the validator, and refuses one with no container', async () => {
  const validatorCalls = video.isPlayable.mock.calls.length + video.playable.mock.calls.length;
  await expect(
    createScreenRecordingFinalizer().sniff({ outputPath: '/tmp/capture.collected.mp4' }),
  ).resolves.toBeUndefined();
  video.container.mockResolvedValueOnce(false);

  await expect(
    createScreenRecordingFinalizer().sniff({ outputPath: '/tmp/capture.collected.mp4' }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'recording-output-unplayable', retriable: true },
  });
  expect(video.isPlayable.mock.calls.length + video.playable.mock.calls.length).toBe(
    validatorCalls,
  );
});
