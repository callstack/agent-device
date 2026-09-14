import { describe, expect, test, vi } from 'vitest';
import { readMp4DurationMs } from '@agent-device/capture-kit/recording-mp4-duration';
import { completed, snapshot } from './completion.ts';
import { recordingHost, recordingInput } from './fixtures.ts';

vi.mock('@agent-device/capture-kit/recording-mp4-duration', () => ({ readMp4DurationMs: vi.fn() }));

const STARTED_AT_MS = 1_789_000_000_000;

async function capture(params: {
  clipMs: number;
  windowMs: number;
  chunks?: number;
  reachedLimit?: boolean;
  finalization?: Record<string, unknown>;
}) {
  vi.mocked(readMp4DurationMs).mockReturnValue(params.clipMs);
  return await completed({
    host: recordingHost({ finalize: { complete: async () => params.finalization ?? {} } }),
    recording: snapshot(recordingInput(), 1),
    chunks: Array.from({ length: params.chunks ?? 1 }, (_, offset) => ({
      index: offset + 1,
      path: offset === 0 ? '/tmp/capture.mp4' : `/tmp/capture.part-${offset + 1}.mp4`,
    })),
    targetLabel: 'Android recording',
    reachedLimit: params.reachedLimit ?? false,
    startedAtMs: STARTED_AT_MS,
    stoppedAtMs: STARTED_AT_MS + params.windowMs,
  });
}

describe('completed', () => {
  test('reports the clip the recorder really captured beside the requested window', async () => {
    const outcome = await capture({
      clipMs: 7_000,
      windowMs: 16_000,
      finalization: { telemetryPath: '/tmp/capture.gesture-telemetry.json' },
    });
    expect(outcome.result).toMatchObject({
      telemetryPath: '/tmp/capture.gesture-telemetry.json',
      capturedDurationMs: 7_000,
      warning:
        'Android screenrecord encodes a frame only when the screen changes, so this video ends at ' +
        'the last frame it encoded: it covers 7.0s of the 16.0s recording window.',
    });
  });

  test('appends every recording warning behind the finalizer warning', async () => {
    const outcome = await capture({
      clipMs: 180_000,
      windowMs: 400_000,
      chunks: 2,
      reachedLimit: true,
      finalization: { warning: 'recording was exported without touch overlays' },
    });
    const warning = outcome.result.warning ?? '';
    expect(warning).toMatch(
      /^recording was exported without touch overlays Android adb screenrecord stopped before record stop/,
    );
    expect(warning.indexOf('is capped at 180s')).toBeLessThan(
      warning.indexOf('encodes a frame only'),
    );
    expect(outcome.result.capturedDurationMs).toBe(360_000);
  });
});
