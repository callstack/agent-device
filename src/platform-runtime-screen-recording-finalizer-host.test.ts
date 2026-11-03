import { beforeEach, expect, test, vi } from 'vitest';
import { bindTestCommandHost, createLiveTestHostEnvironment } from '@agent-device/test-kit';
import {
  OVERLAY_BUDGET_MS,
  type overlayRecordingTouches,
} from '@agent-device/capture-kit/recording-overlay';
import { Deadline } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';

const video = vi.hoisted(() => ({
  stable: vi.fn(async () => {}),
  playable: vi.fn(async (_path: string, _options: { deadline?: Deadline }) => true),
  isPlayable: vi.fn(async (_path: string, _host: unknown, _deadline?: Deadline) => true),
  container: vi.fn(async () => true),
  prepare: vi.fn(async () => ({ executablePath: '/bin/true', env: {} })),
  read: vi.fn<() => Promise<{ executablePath: string; env: NodeJS.ProcessEnv }> | undefined>(),
}));
const telemetry = vi.hoisted(() => vi.fn(() => '/tmp/capture.telemetry.json'));
const overlay = vi.hoisted(() => vi.fn<typeof overlayRecordingTouches>(async () => {}));
bindTestCommandHost();

vi.mock('@agent-device/capture-kit/recording-video', () => ({
  waitForStableFile: video.stable,
  waitForPlayableVideo: video.playable,
  isPlayableVideo: video.isPlayable,
  hasVideoContainer: video.container,
  prepareVideoValidator: video.prepare,
  readPreparedVideoValidator: video.read,
}));
vi.mock('@agent-device/capture-kit/recording-telemetry', () => ({
  persistRecordingTelemetry: telemetry,
}));
vi.mock('@agent-device/capture-kit/recording-overlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/capture-kit/recording-overlay')>()),
  getRecordingOverlaySupportWarning: () => undefined,
  overlayRecordingTouches: overlay,
}));

// The mocks are module-level, so a leaked call count or queued once-value from one case would make
// the next pass for the wrong reason. Restore the hoisted defaults and clear history per test; the
// per-test mockRejectedValueOnce/mockResolvedValueOnce overrides run after this and still win.
beforeEach(() => {
  overlay.mockReset().mockResolvedValue(undefined);
  video.stable.mockReset().mockResolvedValue(undefined);
  video.playable.mockReset().mockResolvedValue(true);
  video.isPlayable.mockReset().mockResolvedValue(true);
  video.container.mockReset().mockResolvedValue(true);
  video.prepare.mockReset().mockResolvedValue({ executablePath: '/bin/true', env: {} });
  video.read.mockReset();
});

test('requires stable playable media before publishing finalization telemetry', async () => {
  const validator = Promise.resolve({ executablePath: '/prepared/validator', env: {} });
  video.prepare.mockReturnValue(validator);
  video.read.mockReturnValue(validator);
  const finalizer = createScreenRecordingFinalizer(createLiveTestHostEnvironment());
  await finalizer.prepare({ container: 'mp4' });
  expect(video.prepare).toHaveBeenCalledOnce();
  const result = await finalizer.complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: false,
    gestureEvents: [],
    targetLabel: 'test recording',
  });

  expect(video.stable).toHaveBeenCalledWith('/tmp/capture.mp4');
  expect(video.playable).toHaveBeenCalledWith('/tmp/capture.mp4', {
    validator,
    deadline: expect.any(Deadline),
  });
  expect(result).toEqual({ telemetryPath: '/tmp/capture.telemetry.json' });
});

test('names the retry and the escape for a recording that never became playable', async () => {
  video.playable.mockResolvedValueOnce(false);

  await expect(
    createScreenRecordingFinalizer(createLiveTestHostEnvironment()).complete({
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

test('a validator that was not prepared reaches the caller as its own retriable error', async () => {
  const compileTimeout = new AppError('COMMAND_FAILED', 'The video validator was not prepared', {
    reason: 'video_validator_not_prepared',
    retriable: true,
  });
  video.playable.mockRejectedValueOnce(compileTimeout);

  await expect(
    createScreenRecordingFinalizer(createLiveTestHostEnvironment()).complete({
      outputPath: '/tmp/capture.mp4',
      showTouches: false,
      gestureEvents: [],
      targetLabel: 'test recording',
    }),
  ).rejects.toBe(compileTimeout);
  expect(telemetry).not.toHaveBeenCalled();
});

test('burns touches into a playable recording without a warning', async () => {
  const result = await createScreenRecordingFinalizer(createLiveTestHostEnvironment()).complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: true,
    gestureEvents: [{ kind: 'tap', tMs: 500, x: 10, y: 20 }],
    targetLabel: 'test recording',
  });

  expect(overlay).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ telemetryPath: '/tmp/capture.telemetry.json' });
});

test('hands the caller fps to the touch overlay', async () => {
  await createScreenRecordingFinalizer(createLiveTestHostEnvironment()).complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: true,
    gestureEvents: [{ kind: 'tap', tMs: 500, x: 10, y: 20 }],
    fps: 15,
    targetLabel: 'test recording',
  });

  expect(overlay).toHaveBeenCalledWith(expect.objectContaining({ fps: 15 }));
});

test('the overlay budget covers the playability checks that run before the overlay', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const playabilityMs = 25_000;
    video.stable.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + playabilityMs);
    });

    await createScreenRecordingFinalizer(createLiveTestHostEnvironment()).complete({
      outputPath: '/tmp/capture.mp4',
      showTouches: true,
      gestureEvents: [{ kind: 'tap', tMs: 500, x: 10, y: 20 }],
      targetLabel: 'test recording',
    });

    const budget = overlay.mock.calls[0]![0].deadline;
    expect(budget.remainingMs()).toBe(OVERLAY_BUDGET_MS - playabilityMs);
    expect(video.playable.mock.calls[0]![1].deadline).toBe(budget);
  } finally {
    vi.useRealTimers();
  }
});

test('a recording confirmed playable as the budget runs out is not refused by a second check', async () => {
  // A check after the budget is spent reads as not playable, so the finalizer decides on the
  // verdict of the wait that confirmed the file rather than asking again. Any second check, with
  // the spent budget or without one, refuses here.
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    video.isPlayable.mockResolvedValue(false);
    video.playable.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + OVERLAY_BUDGET_MS);
      return true;
    });

    await expect(
      createScreenRecordingFinalizer(createLiveTestHostEnvironment()).complete({
        outputPath: '/tmp/capture.mp4',
        showTouches: false,
        gestureEvents: [],
        targetLabel: 'test recording',
      }),
    ).resolves.toEqual({ telemetryPath: '/tmp/capture.telemetry.json' });
    expect(video.isPlayable).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
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

  const result = await createScreenRecordingFinalizer(createLiveTestHostEnvironment()).complete({
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

  const result = await createScreenRecordingFinalizer(createLiveTestHostEnvironment()).complete({
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
    createScreenRecordingFinalizer(createLiveTestHostEnvironment()).sniff({
      outputPath: '/tmp/capture.collected.mp4',
    }),
  ).resolves.toBeUndefined();
  video.container.mockResolvedValueOnce(false);

  await expect(
    createScreenRecordingFinalizer(createLiveTestHostEnvironment()).sniff({
      outputPath: '/tmp/capture.collected.mp4',
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'recording-output-unplayable', retriable: true },
  });
  expect(video.isPlayable.mock.calls.length + video.playable.mock.calls.length).toBe(
    validatorCalls,
  );
});
