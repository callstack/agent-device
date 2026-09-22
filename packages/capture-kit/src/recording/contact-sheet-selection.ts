import {
  computePngChangedPixels,
  type PngChangedRegion,
  type PngRgbImage,
} from '../png-changed-pixels.ts';

/**
 * Which sampled frames earn a cell of their own.
 *
 * A cell is kept when it moves enough of the frame relative to the cell kept *before* it, not
 * relative to its immediate predecessor. Comparing with the previous kept cell is what lets small
 * changes add up: a list that scrolls one row per frame keeps nothing against its own predecessor
 * and everything against the last frame that was shown.
 *
 * Calibrated on iOS simulator recordings at this sheet's 360px comparison width: an idle status-bar
 * clock tick measures up to 0.009, while the smallest change worth a cell — a pane arriving over
 * unchanged chrome — measured 0.030. Any value in that gap separates the two, and this one sits
 * nearer the noise so a quiet change costs an extra cell instead of going unshown.
 */
export const CONTACT_SHEET_CHANGED_PIXEL_THRESHOLD = 0.02;

/** Cells one sheet prints. The grid thins evenly across time to hold this, keeping both ends. */
export const MAX_CONTACT_SHEET_CELLS = 24;

export type ContactSheetSample = Readonly<{
  /** Presentation time the decoder reported for this frame, in milliseconds from the clip start. */
  timeMs: number;
  image: PngRgbImage;
}>;

export type ContactSheetCell = Readonly<{
  timeMs: number;
  changedPixelRatio: number;
  /** Where the frame moved against the cell before it, or null when there is nothing to point at. */
  changedRegion: PngChangedRegion | null;
  image: PngRgbImage;
}>;

export type ContactSheetSelection = Readonly<{
  cells: readonly ContactSheetCell[];
  /** Cells the rule kept before the grid was thinned to `MAX_CONTACT_SHEET_CELLS`. */
  keptCellCount: number;
  /** Whether thinning dropped kept cells, which the sheet discloses rather than hides. */
  thinned: boolean;
}>;

export function selectContactSheetCells(
  samples: readonly ContactSheetSample[],
  threshold: number = CONTACT_SHEET_CHANGED_PIXEL_THRESHOLD,
  maxCells: number = MAX_CONTACT_SHEET_CELLS,
): ContactSheetSelection {
  const kept: ContactSheetCell[] = [];
  let baseline: PngRgbImage | undefined;

  for (const sample of samples) {
    const change: MeasuredChange = baseline
      ? measureChangeAgainst(baseline, sample.image)
      : // The first frame has nothing to differ from; it establishes the sheet's starting state.
        { changedPixelRatio: 1, changedRegion: null };
    if (change.changedPixelRatio < threshold) continue;
    kept.push({ timeMs: sample.timeMs, ...change, image: sample.image });
    baseline = sample.image;
  }

  keepFinalState(kept, samples);

  const cells = kept.length > maxCells ? thinEvenly(kept, maxCells) : kept;
  return {
    cells,
    keptCellCount: kept.length,
    thinned: cells.length < kept.length,
  };
}

/**
 * Ends the sheet with the last frame the decoder returned.
 *
 * The rule alone would drop a clip that settles quietly: a screen that fades rather than moves
 * keeps only its opening cell, and the caller is left with no picture of where the recording
 * ended — which is the state a caller most often wants checked. The endpoint is appended with the
 * ratio it actually measured, so a cell that is there for coverage rather than change still says
 * so.
 */
function keepFinalState(kept: ContactSheetCell[], samples: readonly ContactSheetSample[]): void {
  const final = samples.at(-1);
  if (!final) return;
  const previous = kept.at(-1);
  if (!previous || previous.timeMs === final.timeMs) return;
  kept.push({
    timeMs: final.timeMs,
    ...measureChangeAgainst(previous.image, final.image),
    image: final.image,
  });
}

type MeasuredChange = Pick<ContactSheetCell, 'changedPixelRatio' | 'changedRegion'>;

function measureChangeAgainst(baseline: PngRgbImage, candidate: PngRgbImage): MeasuredChange {
  const change = computePngChangedPixels(baseline, candidate);
  // A frame that changed shape reshaped the whole picture, which is the largest change there is.
  // Nothing is left to point at inside a frame that was resized, so it reports no region.
  return change.status === 'compared'
    ? { changedPixelRatio: change.changedPixelRatio, changedRegion: change.region }
    : { changedPixelRatio: 1, changedRegion: null };
}

function thinEvenly(
  kept: readonly ContactSheetCell[],
  maxCells: number,
): readonly ContactSheetCell[] {
  if (maxCells <= 1) return [kept.at(-1)!];
  const stride = (kept.length - 1) / (maxCells - 1);
  return Array.from({ length: maxCells }, (_, index) => kept[Math.round(index * stride)]!);
}
