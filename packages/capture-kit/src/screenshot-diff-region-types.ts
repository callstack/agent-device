export type MutableDiffRegion = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  differentPixels: number;
  baselineRed: number;
  baselineGreen: number;
  baselineBlue: number;
  currentRed: number;
  currentGreen: number;
  currentBlue: number;
};
