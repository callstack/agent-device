import { describe, expect, test, vi } from 'vitest';
import { readMp4DurationMs } from '@agent-device/capture-kit/recording-mp4-duration';
import { measureCapturedWindow } from './captured-window.ts';

vi.mock('@agent-device/capture-kit/recording-mp4-duration', () => ({ readMp4DurationMs: vi.fn() }));

const measured = vi.mocked(readMp4DurationMs);
const STARTED_AT_MS = 1_789_000_000_000;

function capture(durations: readonly (number | undefined)[], windowMs: number) {
  let index = 0;
  measured.mockImplementation(() => durations[index++]);
  return measureCapturedWindow({
    chunkPaths: durations.map((_, offset) =>
      offset === 0 ? '/tmp/capture.mp4' : `/tmp/capture.part-${offset + 1}.mp4`,
    ),
    startedAtMs: STARTED_AT_MS,
    stoppedAtMs: STARTED_AT_MS + windowMs,
  });
}

describe('measureCapturedWindow', () => {
  test('names the clip length and the window length it fell short of', () => {
    expect(capture([7_000], 16_000)).toEqual({
      capturedDurationMs: 7_000,
      idleTailWarning:
        'Android screenrecord encodes a frame only when the screen changes, so this video ends at ' +
        'the last frame it encoded: it covers 7.0s of the 16.0s recording window.',
    });
  });

  test('warns for a window the recorder never drew on', () => {
    expect(capture([0], 13_000)).toEqual({
      capturedDurationMs: 0,
      idleTailWarning:
        'Android screenrecord encodes a frame only when the screen changes, so this video ends at ' +
        'the last frame it encoded: it covers 0.0s of the 13.0s recording window.',
    });
  });

  test('reports the clip length without a warning when the tail is export latency', () => {
    expect(capture([6_998], 7_000)).toEqual({ capturedDurationMs: 6_998 });
  });

  test('sums the video of a chunked capture', () => {
    expect(capture([170_000, 9_000], 180_500)).toEqual({ capturedDurationMs: 179_000 });
  });

  test('leaves a capture longer than its window unexplained rather than inventing a tail', () => {
    expect(capture([180_000], 60_000)).toEqual({ capturedDurationMs: 180_000 });
  });

  test('reports the clip length when the host clock moved the window backwards', () => {
    expect(capture([7_000], -1_000)).toEqual({ capturedDurationMs: 7_000 });
  });

  test('stays silent when a chunk cannot answer with a duration', () => {
    expect(capture([7_000, undefined], 16_000)).toEqual({});
  });
});
