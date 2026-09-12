/**
 * The row predictors PNG defines, shared by whoever reads or writes a filtered scanline.
 *
 * Both sides must agree byte for byte: a writer and a reader that each carry their own copy of
 * these rules drift apart silently, and the damage shows up as wrong pixels in a file that opens
 * fine.
 */

export const PREDICT_NONE = 0;
export const PREDICT_SUB = 1;
export const PREDICT_UP = 2;
const PREDICT_AVERAGE = 3;
export const PREDICT_PAETH = 4;

/** The scanline filter types a reader must be able to undo. */
export const PNG_ROW_FILTERS: readonly number[] = [
  PREDICT_NONE,
  PREDICT_SUB,
  PREDICT_UP,
  PREDICT_AVERAGE,
  PREDICT_PAETH,
];

/** Reconstructs one byte from its neighbours, where a missing neighbour reads as zero. */
export function predictByte(filter: number, left: number, up: number, upperLeft: number): number {
  switch (filter) {
    case PREDICT_SUB:
      return left;
    case PREDICT_UP:
      return up;
    case PREDICT_AVERAGE:
      return (left + up) >> 1;
    case PREDICT_PAETH:
      return paethPredictor(left, up, upperLeft);
    default:
      return 0;
  }
}

export function paethPredictor(left: number, up: number, upperLeft: number): number {
  const estimated = left + up - upperLeft;
  const leftDistance = Math.abs(estimated - left);
  const upDistance = Math.abs(estimated - up);
  const upperLeftDistance = Math.abs(estimated - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

export function addByte(value: number, predictor: number): number {
  return (value + predictor) & 0xff;
}
