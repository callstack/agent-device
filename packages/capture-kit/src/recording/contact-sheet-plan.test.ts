import { describe, expect, test } from 'vitest';
import { CONTACT_SHEET_DURATION_REASON } from './contact-sheet-report.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  CONTACT_SHEET_SAMPLE_INTERVAL_MS,
  MAX_CONTACT_SHEET_SAMPLED_FRAMES,
  planContactSheetSampleTimes,
} from './contact-sheet-plan.ts';

const VIDEO = '/tmp/recording.mp4';

function reasonOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error instanceof AppError ? error.details?.reason : `not an AppError: ${String(error)}`;
  }
  return 'no error thrown';
}

describe('planContactSheetSampleTimes', () => {
  test('names both endpoints of a clip no longer than one sample step', () => {
    expect(planContactSheetSampleTimes(0, VIDEO)).toEqual({ durationMs: 0, timesMs: [0] });
    // One step is not one frame: a clip can change between its first and last presentation sample,
    // and the sheet promises its ending whatever the clip's length.
    expect(planContactSheetSampleTimes(CONTACT_SHEET_SAMPLE_INTERVAL_MS, VIDEO)).toEqual({
      durationMs: CONTACT_SHEET_SAMPLE_INTERVAL_MS,
      timesMs: [0, CONTACT_SHEET_SAMPLE_INTERVAL_MS],
    });
    expect(planContactSheetSampleTimes(100, VIDEO)).toEqual({ durationMs: 100, timesMs: [0, 100] });
  });

  test('samples every step while the clip is shorter than the cap', () => {
    expect(planContactSheetSampleTimes(1_000, VIDEO).timesMs).toEqual([0, 250, 500, 750, 1000]);
  });

  test('stretches the same grid over a long clip instead of adding samples', () => {
    const hour = planContactSheetSampleTimes(3_600_000, VIDEO);

    expect(hour.timesMs).toHaveLength(MAX_CONTACT_SHEET_SAMPLED_FRAMES);
    expect(hour.timesMs[0]).toBe(0);
    expect(hour.timesMs.at(-1)).toBe(3_600_000);
    expect(new Set(hour.timesMs).size).toBe(MAX_CONTACT_SHEET_SAMPLED_FRAMES);
    hour.timesMs.forEach((time, index) => {
      if (index > 0) expect(time).toBeGreaterThan(hour.timesMs[index - 1]!);
    });
  });

  test('keeps both endpoints, which is what a coverage claim rests on', () => {
    for (const durationMs of [5_000, 41_000, 900_000, 7_200_000]) {
      const plan = planContactSheetSampleTimes(durationMs, VIDEO);
      expect(plan.durationMs).toBe(durationMs);
      expect(plan.timesMs[0]).toBe(0);
      expect(plan.timesMs.at(-1)).toBe(durationMs);
    }
  });

  test('refuses to plan over a timeline the container cannot name', () => {
    expect(reasonOf(() => planContactSheetSampleTimes(undefined, VIDEO))).toBe(
      CONTACT_SHEET_DURATION_REASON,
    );
    expect(reasonOf(() => planContactSheetSampleTimes(Number.NaN, VIDEO))).toBe(
      CONTACT_SHEET_DURATION_REASON,
    );
    expect(reasonOf(() => planContactSheetSampleTimes(-1, VIDEO))).toBe(
      CONTACT_SHEET_DURATION_REASON,
    );
  });
});
