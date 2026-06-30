import { promises as fs } from 'node:fs';
import {
  centerOfRect,
  type Rect,
  type ScreenshotOverlayRef,
  type SnapshotNode,
  type SnapshotState,
} from '../kernel/snapshot.ts';
import type { PNG } from '../utils/png.ts';
import { decodePngAsync, encodePngAsync } from '../utils/png-worker-client.ts';
import { analyzeReactNativeOverlay } from '../core/react-native-overlay.ts';
import { findNearestAncestor, normalizeType } from '../snapshot/snapshot-processing.ts';
import { resolveAndroidOverlaySourceRect } from './screenshot-overlay-android.ts';
import { hasPositiveRect, rectArea, rectContains } from './screenshot-overlay-rects.ts';

const MAX_OVERLAY_REFS = 24;
const BORDER_COLOR = [255, 59, 48, 255] as const;
const BADGE_COLOR = [255, 214, 10, 255] as const;
const TEXT_COLOR = [0, 0, 0, 255] as const;
const FONT_WIDTH = 5;
const FONT_HEIGHT = 7;
const FONT_SPACING = 1;
const BADGE_PADDING_X = 3;
const BADGE_PADDING_Y = 2;
const BADGE_MARGIN = 2;
const BORDER_THICKNESS = 2;
const ANDROID_UNLABELED_CLICKABLE_EXCLUDED_TYPES = [
  'scroll',
  'list',
  'recyclerview',
  'edittext',
  'textfield',
] as const;
const ACTIONABLE_ROLE_TYPES = [
  'button',
  'link',
  'menu',
  'tab',
  'textfield',
  'searchfield',
  'securetextfield',
  'checkbox',
  'radio',
  'switch',
  'cell',
] as const;

const FONT: Record<string, readonly string[]> = {
  e: ['01110', '10000', '11110', '10000', '10000', '10001', '01110'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
} as const;
// Badges currently render only `eN` refs, so the bitmap font intentionally covers `e` and digits.

type OverlayCandidate = Omit<ScreenshotOverlayRef, 'center'> & {
  score: number;
};

export async function annotateScreenshotWithRefs(params: {
  screenshotPath: string;
  snapshot: SnapshotState;
  maxRefs?: number;
}): Promise<ScreenshotOverlayRef[]> {
  const screenshotBuffer = await fs.readFile(params.screenshotPath);
  // Decode/encode run on the PNG worker thread so multi-MB screenshots do not
  // block the daemon event loop; overlay drawing itself is cheap.
  const png = await decodePngAsync(screenshotBuffer, 'screenshot');
  const overlayRefs = buildScreenshotOverlayRefs(params.snapshot, png.width, png.height, {
    maxRefs: params.maxRefs,
  });

  for (const overlayRef of overlayRefs) {
    drawOverlayRef(png, overlayRef);
  }

  await fs.writeFile(params.screenshotPath, await encodePngAsync(png));
  return overlayRefs;
}

export function buildScreenshotOverlayRefs(
  snapshot: SnapshotState,
  screenshotWidth: number,
  screenshotHeight: number,
  options: { maxRefs?: number } = {},
): ScreenshotOverlayRef[] {
  const snapshotBounds = resolveSnapshotBounds(snapshot.nodes);
  const candidatesByRef = new Map<string, OverlayCandidate>();
  for (const node of snapshot.nodes) {
    if (!isOverlaySourceNode(snapshot, snapshotBounds, node)) continue;
    const target = resolveOverlayTarget(snapshot.nodes, node);
    if (!target?.rect || !hasPositiveRect(target.rect)) continue;
    const label = resolveOverlayLabel(node, target, snapshot.nodes);
    const score = scoreOverlayCandidate(node, target, label);
    const overlaySourceRect = resolveOverlaySourceRect(snapshot, target, snapshot.nodes);
    const overlayRect = projectRectToScreenshot(
      snapshot,
      snapshotBounds,
      overlaySourceRect,
      screenshotWidth,
      screenshotHeight,
    );
    if (!hasPositiveRect(overlayRect)) continue;
    const existing = candidatesByRef.get(target.ref);
    if (!existing || score > existing.score) {
      candidatesByRef.set(target.ref, {
        ref: target.ref,
        label,
        rect: target.rect,
        overlayRect,
        score,
      });
    }
  }
  addReactNativeOverlayActionCandidates(
    snapshot,
    snapshotBounds,
    candidatesByRef,
    screenshotWidth,
    screenshotHeight,
  );

  const ranked = suppressContainedCandidates([...candidatesByRef.values()])
    .sort(compareOverlayCandidatesByScore)
    .slice(0, options.maxRefs ?? MAX_OVERLAY_REFS)
    .sort(compareOverlayCandidatesByPosition);

  return ranked.map((candidate) => ({
    ref: candidate.ref,
    label: candidate.label,
    rect: candidate.rect,
    overlayRect: candidate.overlayRect,
    center: centerOfRect(candidate.overlayRect),
  }));
}

function addReactNativeOverlayActionCandidates(
  snapshot: SnapshotState,
  snapshotBounds: Rect | null,
  candidatesByRef: Map<string, OverlayCandidate>,
  screenshotWidth: number,
  screenshotHeight: number,
): void {
  const overlay = analyzeReactNativeOverlay(snapshot.nodes);
  const action = overlay.primaryAction;
  if (!action?.ref || !action.rect || !hasPositiveRect(action.rect)) return;

  const overlayRect = projectRectToScreenshot(
    snapshot,
    snapshotBounds,
    action.rect,
    screenshotWidth,
    screenshotHeight,
  );
  if (!hasPositiveRect(overlayRect)) return;
  const candidate: OverlayCandidate = {
    ref: action.ref,
    label: action.label,
    rect: action.rect,
    overlayRect,
    score: 100,
  };
  const existing = candidatesByRef.get(action.ref);
  candidatesByRef.set(
    action.ref,
    existing
      ? {
          ...existing,
          score: Math.max(existing.score, candidate.score),
        }
      : candidate,
  );
}

function resolveOverlaySourceRect(
  snapshot: SnapshotState,
  target: SnapshotNode,
  nodes: SnapshotState['nodes'],
): Rect {
  if (snapshot.backend !== 'android') return target.rect!;
  return (
    resolveAndroidOverlaySourceRect(target, nodes, hasActionableRole, (node) =>
      Boolean(resolveNodeOverlayLabel(node)),
    ) ?? target.rect!
  );
}

function isOverlaySourceNode(
  snapshot: SnapshotState,
  snapshotBounds: Rect | null,
  node: SnapshotNode,
): boolean {
  const hasTextSignal =
    [node.label, node.value].some(isOverlaySignal) ||
    isMeaningfulOverlayIdentifier(node.identifier);
  if (isAndroidUnlabeledClickableSource(snapshot, snapshotBounds, node)) return true;
  if (hasActionableRole(node)) return hasTextSignal;
  return hasTextSignal && isProxyOverlayNode(node);
}

function isAndroidUnlabeledClickableSource(
  snapshot: SnapshotState,
  snapshotBounds: Rect | null,
  node: SnapshotNode,
): boolean {
  if (snapshot.backend !== 'android') return false;
  if (!node.hittable || !hasPositiveRect(node.rect) || isViewportLikeNode(node)) return false;
  const normalizedType = normalizeType(node.type ?? '');
  if (ANDROID_UNLABELED_CLICKABLE_EXCLUDED_TYPES.some((type) => normalizedType.includes(type))) {
    return false;
  }
  if (snapshotBounds && rectArea(node.rect) > rectArea(snapshotBounds) * 0.25) return false;
  return true;
}

function resolveOverlayTarget(
  nodes: SnapshotState['nodes'],
  node: SnapshotNode,
): SnapshotNode | null {
  return (
    [
      isOverlayActionableNode(node) ? node : null,
      findNearestAncestor(nodes, node, (parent) => isOverlayActionableNode(parent)),
      node.hittable ? node : null,
      findNearestAncestor(nodes, node, (parent) => parent.hittable === true),
    ].find(isUsableOverlayTarget) ?? null
  );
}

function resolveOverlayLabel(
  source: SnapshotNode,
  target: SnapshotNode,
  nodes: SnapshotState['nodes'],
): string | undefined {
  const sourceLabel = resolveNodeOverlayLabel(source);
  if (source.ref !== target.ref && sourceLabel) return sourceLabel;
  const descendantLabel = findDescendantOverlayLabel(target, nodes);
  if (descendantLabel) return descendantLabel;
  return resolveNodeOverlayLabel(target);
}

function scoreOverlayCandidate(
  source: SnapshotNode,
  target: SnapshotNode,
  label: string | undefined,
): number {
  let score = 0;
  if (source.ref === target.ref) score += 4;
  if (target.hittable) score += 3;
  if (hasActionableRole(target)) score += 3;
  if (hasActionableRole(source)) score += 2;
  if (label) score += 2;
  if (isMeaningfulOverlayIdentifier(target.identifier)) score += 1;
  if (isMeaningfulSignal(target.value)) score += 1;
  return score;
}

function suppressContainedCandidates(candidates: OverlayCandidate[]): OverlayCandidate[] {
  const kept: OverlayCandidate[] = [];
  // Candidate counts are intentionally bounded by snapshot-derived actionable elements
  // and a hard max overlay cap, so this quadratic duplicate pass stays small in practice.
  for (const candidate of candidates.sort(
    (left, right) => rectArea(left.overlayRect) - rectArea(right.overlayRect),
  )) {
    const duplicateIndex = kept.findIndex(
      (current) =>
        current.label !== undefined &&
        current.label === candidate.label &&
        (rectContains(current.overlayRect, candidate.overlayRect) ||
          rectContains(candidate.overlayRect, current.overlayRect)),
    );
    if (duplicateIndex === -1) {
      kept.push(candidate);
      continue;
    }
    if (rectArea(candidate.overlayRect) < rectArea(kept[duplicateIndex]!.overlayRect)) {
      kept[duplicateIndex] = candidate;
    }
  }
  return kept;
}

function projectRectToScreenshot(
  snapshot: SnapshotState,
  bounds: Rect | null,
  rect: Rect,
  screenshotWidth: number,
  screenshotHeight: number,
): Rect {
  if (snapshot.backend === 'android') {
    return clampRect(roundRect(rect), screenshotWidth, screenshotHeight);
  }
  if (!bounds) {
    return clampRect(roundRect(rect), screenshotWidth, screenshotHeight);
  }
  const scaleX = screenshotWidth / bounds.width;
  const scaleY = screenshotHeight / bounds.height;
  return clampRect(
    {
      x: Math.round((rect.x - bounds.x) * scaleX),
      y: Math.round((rect.y - bounds.y) * scaleY),
      width: Math.max(1, Math.round(rect.width * scaleX)),
      height: Math.max(1, Math.round(rect.height * scaleY)),
    },
    screenshotWidth,
    screenshotHeight,
  );
}

function resolveSnapshotBounds(nodes: SnapshotState['nodes']): Rect | null {
  let viewport: Rect | null = null;
  for (const node of nodes) {
    if (!isViewportLikeNode(node) || !hasPositiveRect(node.rect)) continue;
    if (!viewport || rectArea(node.rect) > rectArea(viewport)) {
      viewport = node.rect;
    }
  }
  if (viewport) return viewport;

  return measureSnapshotBounds(
    nodes.filter((node) => hasPositiveRect(node.rect) && !isSnapshotBoundsOutlier(node)),
  );
}

function measureSnapshotBounds(nodes: Array<Pick<SnapshotNode, 'rect'>>): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxRight = Number.NEGATIVE_INFINITY;
  let maxBottom = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    if (!node.rect || !hasPositiveRect(node.rect)) continue;
    minX = Math.min(minX, node.rect.x);
    minY = Math.min(minY, node.rect.y);
    maxRight = Math.max(maxRight, node.rect.x + node.rect.width);
    maxBottom = Math.max(maxBottom, node.rect.y + node.rect.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxRight <= minX || maxBottom <= minY) {
    return null;
  }
  return {
    x: minX,
    y: minY,
    width: maxRight - minX,
    height: maxBottom - minY,
  };
}

function isSnapshotBoundsOutlier(node: SnapshotNode): boolean {
  const normalizedType = normalizeType(node.type ?? '');
  return normalizedType === 'image' && !isMeaningfulSignal(node.label);
}

function hasActionableRole(node: SnapshotNode): boolean {
  const roleText = [node.type, node.role, node.subrole]
    .map((value) => normalizeType(value ?? ''))
    .join(' ');
  return ACTIONABLE_ROLE_TYPES.some((type) => roleText.includes(type));
}

function isOverlayActionableNode(node: SnapshotNode): boolean {
  return hasActionableRole(node) && !isViewportLikeNode(node);
}

function isProxyOverlayNode(node: SnapshotNode): boolean {
  const normalizedType = normalizeType(node.type ?? '');
  return (
    normalizedType.includes('statictext') ||
    normalizedType.includes('image') ||
    normalizedType.includes('text') ||
    normalizedType.includes('other')
  );
}

function isViewportLikeNode(node: Pick<SnapshotNode, 'type' | 'role' | 'subrole'>): boolean {
  const roleText = [node.type, node.role, node.subrole]
    .map((value) => normalizeType(value ?? ''))
    .join(' ');
  return roleText.includes('application') || roleText.includes('window');
}

function isUsableOverlayTarget(node: SnapshotNode | null): node is SnapshotNode {
  return Boolean(node?.rect && hasPositiveRect(node.rect) && !isViewportLikeNode(node));
}

function isMeaningfulSignal(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(true|false)$/i.test(trimmed)) return false;
  return true;
}

function isOverlaySignal(value: string | undefined): boolean {
  if (!isMeaningfulSignal(value)) return false;
  return !isGenericOverlayLabel(value);
}

function isMeaningfulOverlayIdentifier(value: string | undefined): boolean {
  if (typeof value !== 'string' || !isOverlaySignal(value)) return false;
  return !isGenericOverlayIdentifier(value);
}

function resolveNodeOverlayLabel(node: SnapshotNode): string | undefined {
  const direct = [node.label, node.value].find(isOverlaySignal);
  if (direct) return direct.trim();
  if (isMeaningfulOverlayIdentifier(node.identifier)) return node.identifier!.trim();
  return undefined;
}

function findDescendantOverlayLabel(
  target: SnapshotNode,
  nodes: SnapshotState['nodes'],
): string | undefined {
  let best: { label: string; score: number } | null = null;
  for (const node of nodes) {
    if (node.ref === target.ref || !isDescendantOf(node, target, nodes)) continue;
    const label = resolveNodeOverlayLabel(node);
    if (!label) continue;
    const score = scoreDescendantLabelCandidate(node);
    if (!best || score > best.score) {
      best = { label, score };
    }
  }
  return best?.label;
}

function isDescendantOf(
  node: SnapshotNode,
  ancestor: SnapshotNode,
  nodes: SnapshotState['nodes'],
): boolean {
  let current = node;
  while (current.parentIndex !== undefined) {
    const parent = nodes[current.parentIndex];
    if (!parent) return false;
    if (parent.ref === ancestor.ref) return true;
    current = parent;
  }
  return false;
}

function scoreDescendantLabelCandidate(node: SnapshotNode): number {
  let score = 0;
  const normalizedType = normalizeType(node.type ?? '');
  if (normalizedType.includes('text')) score += 2;
  if (isOverlaySignal(node.label)) score += 2;
  if (isOverlaySignal(node.value)) score += 1;
  return score;
}

function isGenericOverlayLabel(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === 'toolbar' ||
    normalized === 'window' ||
    normalized === 'application' ||
    normalized?.startsWith('vertical scroll bar') === true
  );
}

function isGenericOverlayIdentifier(value: string): boolean {
  return /^[a-z0-9_.]+:id\/[a-z0-9_.-]+$/i.test(value.trim());
}

function compareNumericRefs(left: string, right: string): number {
  const leftValue = Number.parseInt(left.replace(/^\D+/, ''), 10);
  const rightValue = Number.parseInt(right.replace(/^\D+/, ''), 10);
  return leftValue - rightValue;
}

function roundRect(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = clamp(rect.x, 0, Math.max(0, width - 1));
  const y = clamp(rect.y, 0, Math.max(0, height - 1));
  const maxWidth = Math.max(1, width - x);
  const maxHeight = Math.max(1, height - y);
  return {
    x,
    y,
    width: clamp(rect.width, 1, maxWidth),
    height: clamp(rect.height, 1, maxHeight),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function drawOverlayRef(png: PNG, overlayRef: ScreenshotOverlayRef): void {
  drawRectBorder(png, overlayRef.overlayRect, BORDER_COLOR, BORDER_THICKNESS);
  drawBadge(png, overlayRef.overlayRect, overlayRef.ref);
}

function drawRectBorder(
  png: PNG,
  rect: Rect,
  color: readonly [number, number, number, number],
  thickness: number,
): void {
  for (let offset = 0; offset < thickness; offset += 1) {
    drawHorizontalLine(png, rect.x, rect.x + rect.width - 1, rect.y + offset, color);
    drawHorizontalLine(
      png,
      rect.x,
      rect.x + rect.width - 1,
      rect.y + rect.height - 1 - offset,
      color,
    );
    drawVerticalLine(png, rect.x + offset, rect.y, rect.y + rect.height - 1, color);
    drawVerticalLine(
      png,
      rect.x + rect.width - 1 - offset,
      rect.y,
      rect.y + rect.height - 1,
      color,
    );
  }
}

function drawBadge(png: PNG, rect: Rect, text: string): void {
  const badgeWidth =
    BADGE_PADDING_X * 2 + text.length * FONT_WIDTH + Math.max(0, text.length - 1) * FONT_SPACING;
  const badgeHeight = BADGE_PADDING_Y * 2 + FONT_HEIGHT;
  const x = clamp(rect.x, 0, Math.max(0, png.width - badgeWidth));
  const preferredY = rect.y - badgeHeight - BADGE_MARGIN;
  const y =
    preferredY >= 0
      ? preferredY
      : clamp(rect.y + BADGE_MARGIN, 0, Math.max(0, png.height - badgeHeight));
  fillRect(png, x, y, badgeWidth, badgeHeight, BADGE_COLOR);
  drawText(png, x + BADGE_PADDING_X, y + BADGE_PADDING_Y, text, TEXT_COLOR);
}

function drawText(
  png: PNG,
  x: number,
  y: number,
  text: string,
  color: readonly [number, number, number, number],
): void {
  let cursorX = x;
  for (const character of text.toLowerCase()) {
    const glyph = FONT[character];
    if (glyph) {
      for (let row = 0; row < glyph.length; row += 1) {
        for (let column = 0; column < glyph[row]!.length; column += 1) {
          if (glyph[row]![column] !== '1') continue;
          setPixel(png, cursorX + column, y + row, color);
        }
      }
    }
    cursorX += FONT_WIDTH + FONT_SPACING;
  }
}

function fillRect(
  png: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly [number, number, number, number],
): void {
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      setPixel(png, x + column, y + row, color);
    }
  }
}

function drawHorizontalLine(
  png: PNG,
  startX: number,
  endX: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  for (let x = startX; x <= endX; x += 1) {
    setPixel(png, x, y, color);
  }
}

function drawVerticalLine(
  png: PNG,
  x: number,
  startY: number,
  endY: number,
  color: readonly [number, number, number, number],
): void {
  for (let y = startY; y <= endY; y += 1) {
    setPixel(png, x, y, color);
  }
}

function setPixel(
  png: PNG,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const index = (png.width * y + x) * 4;
  png.data[index] = color[0];
  png.data[index + 1] = color[1];
  png.data[index + 2] = color[2];
  png.data[index + 3] = color[3];
}
function compareOverlayCandidatesByPosition(
  left: OverlayCandidate,
  right: OverlayCandidate,
): number {
  const topDelta = left.overlayRect.y - right.overlayRect.y;
  if (topDelta !== 0) return topDelta;
  const leftDelta = left.overlayRect.x - right.overlayRect.x;
  if (leftDelta !== 0) return leftDelta;
  return compareNumericRefs(left.ref, right.ref);
}

function compareOverlayCandidatesByScore(left: OverlayCandidate, right: OverlayCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  return compareOverlayCandidatesByPosition(left, right);
}
