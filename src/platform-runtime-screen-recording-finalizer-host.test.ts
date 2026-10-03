import { beforeEach, expect, test, vi } from 'vitest';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';

const video = vi.hoisted(() => ({
  stable: vi.fn(async () => {}),
  playable: vi.fn(async () => {}),
  isPlayable: vi.fn(async () => true),
  container: vi.fn(async () => true),
}));
const telemetry = vi.hoisted(() => vi.fn(() => '/tmp/capture.telemetry.json'));
const overlay = vi.hoisted(() => vi.fn(async () => {}));
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
  overlayRecordingTouches: overlay,
}));

// The mocks are module-level, so a leaked call count or queued once-value from one case would make
// the next pass for the wrong reason. Restore the hoisted defaults and clear history per test; the
// per-test mockRejectedValueOnce/mockResolvedValueOnce overrides run after this and still win.
beforeEach(() => {
  overlay.mockReset().mockResolvedValue(undefined);
  video.stable.mockReset().mockResolvedValue(undefined);
  video.playable.mockReset().mockResolvedValue(undefined);
  video.isPlayable.mockReset().mockResolvedValue(true);
  video.container.mockReset().mockResolvedValue(true);
});

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

test('burns touches into a playable recording without a warning', async () => {
  const result = await createScreenRecordingFinalizer().complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: true,
    gestureEvents: [{ kind: 'tap', tMs: 500, x: 10, y: 20 }],
    targetLabel: 'test recording',
  });

  expect(overlay).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ telemetryPath: '/tmp/capture.telemetry.json' });
});

test('#2707 reports a dropped overlay and keeps the raw when compositing throws', async () => {
  // overlay.ts verifies the composite and only renames it over the raw on success, so a compositor
  // that fails its own #2707 checks throws before any rename: the raw file survives and the caller
  // learns of the drop from the response, not from a black or shrunken file. This locks the
  // finalizer's drop-and-report contract; the preset/black checks themselves are proven by the
  // AGENT_DEVICE_RECORDING_E2E device lane, which is red against the old 480px preset.
  overlay.mockRejectedValueOnce(
    new Error(
      'Touch overlay export produced an all-black track while the raw capture had visible content.',
    ),
  );

  const result = await createScreenRecordingFinalizer().complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: true,
    gestureEvents: [{ kind: 'tap', tMs: 500, x: 10, y: 20 }],
    targetLabel: 'test recording',
  });

  expect(result).toMatchObject({
    telemetryPath: '/tmp/capture.telemetry.json',
    overlayWarning: expect.stringContaining('failed to overlay recording touches'),
  });
});

test('#2707 reports a warning when a composited recording turns unplayable after burn-in', async () => {
  // Narrower than it looks: overlay.ts confirms the composite playable before renaming, so this only
  // models the post-rename TOCTOU where the file the raw was replaced with goes unplayable. The raw
  // is already overwritten here, so the finalizer can report but not restore — it must not exit 0
  // silently, which the pre-rename probe and the Swift check already prevent for ordinary failures.
  overlay.mockImplementationOnce(async () => {
    video.isPlayable.mockResolvedValueOnce(false);
  });

  const result = await createScreenRecordingFinalizer().complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: true,
    gestureEvents: [{ kind: 'tap', tMs: 500, x: 10, y: 20 }],
    targetLabel: 'test recording',
  });

  expect(result).toMatchObject({
    overlayWarning: expect.stringContaining('failed to overlay recording touches'),
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
