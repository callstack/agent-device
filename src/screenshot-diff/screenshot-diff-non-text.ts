import type { Rect } from '../kernel/snapshot.ts';
import { findConnectedMaskComponents } from './screenshot-diff-components.ts';
import type { ScreenshotOcrAnalysis, ScreenshotOcrBlock } from './screenshot-diff-ocr.ts';
import type { ScreenshotDiffRegion } from './screenshot-diff-regions.ts';
import {
  clamp,
  expandRect,
  intersectArea,
  rectCenter,
  squaredDistance,
  unionRects,
  type ImageDimensions,
} from '../utils/screenshot-geometry.ts';

export type ScreenshotNonTextDelta = {
  index: number;
  regionIndex?: number;
  slot: 'leading' | 'trailing' | 'background' | 'separator' | 'unknown';
  likelyKind: 'icon' | 'toggle' | 'chevron' | 'separator' | 'visual';
  rect: Rect;
  nearestText?: string;
};

type NonTextKind = ScreenshotNonTextDelta['likelyKind'] | 'background';

const MAX_NON_TEXT_DELTAS = 12;
const OCR_MASK_PADDING_PX = 8;
const MIN_COMPONENT_PIXELS = 24;
const MIN_COMPONENT_SIDE = 3;
const MERGE_GAP_PX = 10;
const MIN_CONTENT_Y_RATIO = 0.08;
// Non-text hints classify residual geometry relative to the screenshot size.
// Aspect/density checks describe common UI glyph shapes rather than app-specific elements.
const SEPARATOR_MAX_THICKNESS_PX = 3;
const SEPARATOR_MIN_WIDTH_RATIO = 0.12;
const BACKGROUND_SLOT_WIDTH_RATIO = 0.4;
const UNKNOWN_BACKGROUND_SLOT_WIDTH_RATIO = 0.35;
const LARGE_RESIDUAL_WIDTH_RATIO = 0.25;
const LARGE_RESIDUAL_HEIGHT_RATIO = 0.06;
const TOGGLE_MIN_ASPECT_RATIO = 1.5;
const TOGGLE_MAX_ASPECT_RATIO = 3.8;
const TOGGLE_MIN_DENSITY_RATIO = 0.35;
const CHEVRON_MAX_WIDTH_RATIO = 0.06;
const CHEVRON_MAX_HEIGHT_RATIO = 0.04;
const ICON_MIN_ASPECT_RATIO = 0.55;
const ICON_MAX_ASPECT_RATIO = 1.8;
const LARGE_RESIDUAL_SCORE_PENALTY = -35;
const REGION_OVERLAP_SCORE = 20;
const MAX_PIXEL_COUNT_SCORE = 20;
const PIXELS_PER_SCORE_POINT = 200;
const KIND_SCORE = {
  icon: 90,
  toggle: 90,
  chevron: 75,
  separator: 45,
  visual: 35,
  background: 10,
} satisfies Record<NonTextKind, number>;
const SLOT_SCORE = {
  leading: 20,
  trailing: 20,
  separator: 10,
  unknown: 0,
  background: -30,
} satisfies Record<ScreenshotNonTextDelta['slot'], number>;

type MutableComponent = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  differentPixels: number;
};

type ScoredNonTextDelta = Omit<ScreenshotNonTextDelta, 'index' | 'likelyKind'> & {
  likelyKind: NonTextKind;
  score: number;
};

type OcrRow = {
  rect: Rect;
  blocks: ScreenshotOcrBlock[];
};

export function summarizeNonTextDiffDeltas(params: {
  diffMask: Uint8Array;
  width: number;
  height: number;
  regions: ScreenshotDiffRegion[];
  ocr?: ScreenshotOcrAnalysis;
  maxDeltas?: number;
}): ScreenshotNonTextDelta[] {
  const maskedDiff = maskOcrText(params.diffMask, params.width, params.height, params.ocr);
  const rawComponents = findConnectedComponents(maskedDiff, params.width, params.height);
  const mergedComponents = mergeNearbyComponents(rawComponents, MERGE_GAP_PX);
  const currentRows = groupOcrRows(params.ocr?.currentBlocksRaw ?? []);
  const baselineRows = groupOcrRows(params.ocr?.baselineBlocksRaw ?? []);
  return (
    mergedComponents
      .filter(hasUsefulComponentSize)
      .map((component) => toNonTextDelta(component, params, currentRows, baselineRows))
      // Status bars and top chrome tend to produce noisy residuals around time,
      // signal, and battery text; changed regions still report that area.
      .filter((delta) => delta.rect.y >= params.height * MIN_CONTENT_Y_RATIO)
      .filter(hasAgentFacingKind)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, params.maxDeltas ?? MAX_NON_TEXT_DELTAS))
      .map((delta, index) => toPublicNonTextDelta(delta, index + 1))
  );
}

function maskOcrText(
  diffMask: Uint8Array,
  width: number,
  height: number,
  ocr: ScreenshotOcrAnalysis | undefined,
): Uint8Array {
  const maskedDiff = new Uint8Array(diffMask);
  if (!ocr) return maskedDiff;
  for (const block of [...ocr.baselineBlocksRaw, ...ocr.currentBlocksRaw]) {
    clearRect(maskedDiff, width, height, expandRect(block.rect, OCR_MASK_PADDING_PX));
  }
  return maskedDiff;
}

function findConnectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): MutableComponent[] {
  return findConnectedMaskComponents({
    mask,
    width,
    height,
    hooks: {
      create: (pixelIndex) => createComponent(pixelIndex, width),
      visit: (component, pixelIndex) => addPixelToComponent(component, pixelIndex, width),
    },
  });
}

function createComponent(pixelIndex: number, width: number): MutableComponent {
  const startX = pixelIndex % width;
  const startY = Math.floor(pixelIndex / width);
  return {
    minX: startX,
    minY: startY,
    maxX: startX,
    maxY: startY,
    differentPixels: 0,
  };
}

function addPixelToComponent(component: MutableComponent, pixelIndex: number, width: number): void {
  const x = pixelIndex % width;
  const y = Math.floor(pixelIndex / width);
  component.minX = Math.min(component.minX, x);
  component.minY = Math.min(component.minY, y);
  component.maxX = Math.max(component.maxX, x);
  component.maxY = Math.max(component.maxY, y);
  component.differentPixels += 1;
}

function mergeNearbyComponents(components: MutableComponent[], gapPx: number): MutableComponent[] {
  const merged: MutableComponent[] = [];
  for (const component of components.sort(
    (left, right) => left.minY - right.minY || left.minX - right.minX,
  )) {
    const existing = merged.find((candidate) => componentsAreNear(candidate, component, gapPx));
    if (!existing) {
      merged.push({ ...component });
      continue;
    }
    existing.minX = Math.min(existing.minX, component.minX);
    existing.minY = Math.min(existing.minY, component.minY);
    existing.maxX = Math.max(existing.maxX, component.maxX);
    existing.maxY = Math.max(existing.maxY, component.maxY);
    existing.differentPixels += component.differentPixels;
  }
  return merged;
}

function toNonTextDelta(
  component: MutableComponent,
  params: {
    width: number;
    height: number;
    regions: ScreenshotDiffRegion[];
  },
  currentRows: OcrRow[],
  baselineRows: OcrRow[],
): ScoredNonTextDelta {
  const rect = componentToRect(component);
  const regionIndex = findContainingRegionIndex(rect, params.regions);
  const textAnchor = findTextAnchor(rect, currentRows, baselineRows);
  const slot = classifySlot(rect, textAnchor?.block.rect, params.width);
  const likelyKind = classifyLikelyKind(rect, slot, component.differentPixels, params);
  const scoreParams = {
    ...(regionIndex ? { regionIndex } : {}),
    slot,
    likelyKind,
    rect,
  };
  return {
    ...(regionIndex ? { regionIndex } : {}),
    slot,
    likelyKind,
    rect,
    ...(textAnchor ? { nearestText: cleanOcrAnchorText(textAnchor.block.text) } : {}),
    score: scoreNonTextDelta(scoreParams, component.differentPixels, params),
  };
}

function toPublicNonTextDelta(
  delta: ScoredNonTextDelta & { likelyKind: ScreenshotNonTextDelta['likelyKind'] },
  index: number,
): ScreenshotNonTextDelta {
  return {
    index,
    ...(delta.regionIndex ? { regionIndex: delta.regionIndex } : {}),
    slot: delta.slot,
    likelyKind: delta.likelyKind,
    rect: delta.rect,
    ...(delta.nearestText ? { nearestText: delta.nearestText } : {}),
  };
}

function classifySlot(
  rect: Rect,
  nearestTextRect: Rect | undefined,
  imageWidth: number,
): ScreenshotNonTextDelta['slot'] {
  if (
    rect.height <= SEPARATOR_MAX_THICKNESS_PX &&
    rect.width >= imageWidth * SEPARATOR_MIN_WIDTH_RATIO
  ) {
    return 'separator';
  }
  if (!nearestTextRect) {
    if (rect.width >= imageWidth * BACKGROUND_SLOT_WIDTH_RATIO) return 'background';
    return 'unknown';
  }
  if (rect.width >= imageWidth * BACKGROUND_SLOT_WIDTH_RATIO) return 'background';
  const rectCenterX = rect.x + rect.width / 2;
  const textCenterX = nearestTextRect.x + nearestTextRect.width / 2;
  if (rectCenterX < textCenterX - nearestTextRect.width / 2) return 'leading';
  if (rectCenterX > textCenterX + nearestTextRect.width / 2) return 'trailing';
  return rect.width >= imageWidth * UNKNOWN_BACKGROUND_SLOT_WIDTH_RATIO ? 'background' : 'unknown';
}

function classifyLikelyKind(
  rect: Rect,
  slot: ScreenshotNonTextDelta['slot'],
  differentPixels: number,
  image: ImageDimensions,
): NonTextKind {
  const aspect = rect.width / rect.height;
  const density = differentPixels / (rect.width * rect.height);
  if (slot === 'separator') return 'separator';
  if (slot === 'background') return 'background';
  if (
    slot === 'trailing' &&
    aspect >= TOGGLE_MIN_ASPECT_RATIO &&
    aspect <= TOGGLE_MAX_ASPECT_RATIO &&
    density >= TOGGLE_MIN_DENSITY_RATIO
  ) {
    return 'toggle';
  }
  if (
    slot === 'trailing' &&
    rect.width <= image.width * CHEVRON_MAX_WIDTH_RATIO &&
    rect.height <= image.height * CHEVRON_MAX_HEIGHT_RATIO
  ) {
    return 'chevron';
  }
  if (slot === 'leading' && aspect >= ICON_MIN_ASPECT_RATIO && aspect <= ICON_MAX_ASPECT_RATIO) {
    return 'icon';
  }
  if (isLargeResidual(rect, image)) return 'background';
  return 'visual';
}

function hasAgentFacingKind(
  delta: ScoredNonTextDelta,
): delta is ScoredNonTextDelta & { likelyKind: ScreenshotNonTextDelta['likelyKind'] } {
  return delta.likelyKind !== 'background';
}

function scoreNonTextDelta(
  delta: {
    regionIndex?: number;
    slot: ScreenshotNonTextDelta['slot'];
    likelyKind: NonTextKind;
    rect: Rect;
  },
  differentPixels: number,
  image: ImageDimensions,
): number {
  const sizePenalty = isLargeResidual(delta.rect, image) ? LARGE_RESIDUAL_SCORE_PENALTY : 0;
  const regionScore = delta.regionIndex ? REGION_OVERLAP_SCORE : 0;
  return (
    KIND_SCORE[delta.likelyKind] +
    SLOT_SCORE[delta.slot] +
    regionScore +
    sizePenalty +
    Math.min(MAX_PIXEL_COUNT_SCORE, differentPixels / PIXELS_PER_SCORE_POINT)
  );
}

function isLargeResidual(rect: Rect, image: ImageDimensions): boolean {
  return (
    rect.width >= image.width * LARGE_RESIDUAL_WIDTH_RATIO ||
    rect.height >= image.height * LARGE_RESIDUAL_HEIGHT_RATIO
  );
}

function findContainingRegionIndex(
  rect: Rect,
  regions: ScreenshotDiffRegion[],
): number | undefined {
  let bestRegion: ScreenshotDiffRegion | undefined;
  let bestOverlap = 0;
  for (const region of regions) {
    const overlap = intersectArea(rect, region.rect);
    if (overlap <= bestOverlap) continue;
    bestOverlap = overlap;
    bestRegion = region;
  }
  return bestRegion?.index;
}

function findTextAnchor(
  rect: Rect,
  currentRows: OcrRow[],
  baselineRows: OcrRow[],
): { block: ScreenshotOcrBlock; distance: number } | undefined {
  const currentRow = findOverlappingRow(rect, currentRows);
  if (currentRow) return findNearestText(rect, currentRow.blocks);
  const baselineRow = findOverlappingRow(rect, baselineRows);
  return baselineRow ? findNearestText(rect, baselineRow.blocks) : undefined;
}

function findOverlappingRow(rect: Rect, rows: OcrRow[]): OcrRow | undefined {
  let bestRow: OcrRow | undefined;
  let bestOverlap = 0;
  for (const row of rows) {
    const overlap = verticalOverlap(rect, row.rect);
    if (overlap <= bestOverlap) continue;
    bestOverlap = overlap;
    bestRow = row;
  }
  return bestRow;
}

function groupOcrRows(blocks: ScreenshotOcrBlock[]): OcrRow[] {
  const rows: OcrRow[] = [];
  for (const block of [...blocks].sort((left, right) => left.rect.y - right.rect.y)) {
    const row = rows.find((candidate) => blocksShareRow(candidate.rect, block.rect));
    if (!row) {
      rows.push({ rect: block.rect, blocks: [block] });
      continue;
    }
    row.blocks.push(block);
    row.blocks.sort((left, right) => left.rect.x - right.rect.x);
    row.rect = unionRects([row.rect, block.rect]);
  }
  return rows;
}

function blocksShareRow(left: Rect, right: Rect): boolean {
  const overlap = verticalOverlap(left, right);
  if (overlap > 0) return true;
  const centerDistance = Math.abs(rectCenter(left).y - rectCenter(right).y);
  return centerDistance <= Math.max(left.height, right.height) * 0.5;
}

function findNearestText(
  rect: Rect,
  textBlocks: ScreenshotOcrBlock[],
): { block: ScreenshotOcrBlock; distance: number } | undefined {
  let nearest: { block: ScreenshotOcrBlock; distance: number } | undefined;
  const center = rectCenter(rect);
  for (const block of textBlocks) {
    const distance = Math.sqrt(squaredDistance(center, rectCenter(block.rect)));
    if (nearest && distance >= nearest.distance) continue;
    nearest = { block, distance };
  }
  return nearest;
}

function cleanOcrAnchorText(text: string): string {
  return text
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/^\p{L}\s+/u, '');
}

function hasUsefulComponentSize(component: MutableComponent): boolean {
  const rect = componentToRect(component);
  return (
    component.differentPixels >= MIN_COMPONENT_PIXELS &&
    rect.width >= MIN_COMPONENT_SIDE &&
    rect.height >= MIN_COMPONENT_SIDE
  );
}

function componentToRect(component: MutableComponent): Rect {
  return {
    x: component.minX,
    y: component.minY,
    width: component.maxX - component.minX + 1,
    height: component.maxY - component.minY + 1,
  };
}

function clearRect(mask: Uint8Array, width: number, height: number, rect: Rect): void {
  const minX = clamp(Math.floor(rect.x), 0, width - 1);
  const minY = clamp(Math.floor(rect.y), 0, height - 1);
  const maxX = clamp(Math.ceil(rect.x + rect.width), 0, width);
  const maxY = clamp(Math.ceil(rect.y + rect.height), 0, height);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      mask[y * width + x] = 0;
    }
  }
}

function componentsAreNear(
  left: MutableComponent,
  right: MutableComponent,
  gapPx: number,
): boolean {
  return (
    left.minX - gapPx <= right.maxX &&
    right.minX - gapPx <= left.maxX &&
    left.minY - gapPx <= right.maxY &&
    right.minY - gapPx <= left.maxY
  );
}

function verticalOverlap(left: Rect, right: Rect): number {
  return Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
}
