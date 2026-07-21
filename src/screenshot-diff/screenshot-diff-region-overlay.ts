import type { PNG } from '../utils/png.ts';
import type { ScreenshotDiffRegion } from './screenshot-diff-regions.ts';

const REGION_BORDER_COLOR = [0, 187, 255, 255] as const;
const REGION_BORDER_THICKNESS = 2;
const MIN_ANNOTATED_REGION_SIDE = 4;

export function annotateDiffRegions(diff: PNG, regions: ScreenshotDiffRegion[]): void {
  for (const region of regions) {
    if (
      region.rect.width < MIN_ANNOTATED_REGION_SIDE ||
      region.rect.height < MIN_ANNOTATED_REGION_SIDE
    ) {
      continue;
    }
    drawRect(diff, region.rect);
  }
}

function drawRect(diff: PNG, rect: ScreenshotDiffRegion['rect']): void {
  const bounds = resolveFiniteRectBounds(rect);
  if (bounds == null) return;
  const minX = clamp(bounds.x, 0, diff.width - 1);
  const minY = clamp(bounds.y, 0, diff.height - 1);
  const maxX = clamp(bounds.right, 0, diff.width - 1);
  const maxY = clamp(bounds.bottom, 0, diff.height - 1);
  for (let thickness = 0; thickness < REGION_BORDER_THICKNESS; thickness += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      setPixel(diff, x, minY + thickness, REGION_BORDER_COLOR);
      setPixel(diff, x, maxY - thickness, REGION_BORDER_COLOR);
    }
    for (let y = minY; y <= maxY; y += 1) {
      setPixel(diff, minX + thickness, y, REGION_BORDER_COLOR);
      setPixel(diff, maxX - thickness, y, REGION_BORDER_COLOR);
    }
  }
}

function resolveFiniteRectBounds(rect: ScreenshotDiffRegion['rect']): {
  x: number;
  y: number;
  right: number;
  bottom: number;
} | null {
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  const values = [rect.x, rect.y, rect.width, rect.height, right, bottom];
  if (!values.every(Number.isFinite)) return null;
  return { x: rect.x, y: rect.y, right, bottom };
}

function setPixel(
  diff: PNG,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  if (x < 0 || x >= diff.width || y < 0 || y >= diff.height) return;
  const index = (y * diff.width + x) * 4;
  diff.data[index] = color[0];
  diff.data[index + 1] = color[1];
  diff.data[index + 2] = color[2];
  diff.data[index + 3] = color[3];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
