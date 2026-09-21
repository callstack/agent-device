import { CONTACT_SHEET_DURATION_REASON } from './contact-sheet-report.ts';
import { AppError } from '@agent-device/kernel/errors';

/** Spacing between requested sample times, in milliseconds. */
export const CONTACT_SHEET_SAMPLE_INTERVAL_MS = 250;
/** Sample times one sheet asks the decoder for, however long the clip runs. */
export const MAX_CONTACT_SHEET_SAMPLED_FRAMES = 48;

/**
 * The times to sample from a clip of `durationMs`, spread evenly across the whole timeline.
 *
 * Coverage is the point: the grid always names the start and the end, and it never grows with the
 * recording. A 5s take samples 21 times; a 2h take samples the same 48 times across its length, so
 * a long recording costs the same decode budget as a short one and still shows both endpoints.
 *
 * A grid is a promise with a hole in it. A flash that opens and closes entirely between two sample
 * times is not in the returned frames and no threshold can recover it; that is why the sheet
 * reports how many times it sampled rather than claiming to have reviewed the footage.
 *
 * A clip whose timeline cannot be read is refused rather than guessed at. Sampling an unknown
 * length would mean either walking the whole file or drawing a grid over a duration the container
 * never claimed, and a sheet built that way could not say what it covered.
 */
export type ContactSheetSamplePlan = Readonly<{
  /** Timeline the grid was planned over, in milliseconds. */
  durationMs: number;
  timesMs: readonly number[];
}>;

export function planContactSheetSampleTimes(
  durationMs: number | undefined,
  videoPath: string,
): ContactSheetSamplePlan {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    throw new AppError(
      'COMMAND_FAILED',
      `Cannot plan a contact sheet: the video timeline of ${videoPath} could not be read`,
      {
        reason: CONTACT_SHEET_DURATION_REASON,
        videoPath,
        hint: 'Retry once the recording finished finalizing; a clip whose container is still being written has no readable duration.',
      },
    );
  }
  if (durationMs <= CONTACT_SHEET_SAMPLE_INTERVAL_MS) {
    // A clip shorter than one sampling interval still ends somewhere, and the sheet always promises
    // its last frame, so the closing sample is asked for even when it is the only other one.
    return { durationMs, timesMs: durationMs > 0 ? [0, Math.round(durationMs)] : [0] };
  }

  const count = Math.min(
    MAX_CONTACT_SHEET_SAMPLED_FRAMES,
    Math.floor(durationMs / CONTACT_SHEET_SAMPLE_INTERVAL_MS) + 1,
  );
  const step = durationMs / (count - 1);
  return {
    durationMs,
    timesMs: Array.from({ length: count }, (_, index) => Math.round(index * step)),
  };
}
