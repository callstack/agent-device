import { promises as fs } from 'node:fs';
import {
  centerOfRect,
  type Rect,
  type ScreenshotOverlayRef,
  type SnapshotNode,
  type SnapshotState,
} from '@agent-device/kernel/snapshot';
import { decodePngAsync, encodePngAsync } from '@agent-device/capture-kit/png-worker-client';
import {
  projectSnapshotRectToScreenshot,
  resolveSnapshotBounds,
} from '@agent-device/capture-kit/snapshot-rect-projection';
import { analyzeReactNativeOverlay } from '../core/react-native-overlay.ts';
import {
  findNearestAncestor,
  isMeaningfulSignal,
  isViewportRootNode,
  normalizeType,
} from '@agent-device/contracts/snapshot';
import {
  isAndroidUnlabeledClickableSource,
  resolveAndroidOverlaySourceRect,
} from '../snapshot/screenshot-overlay/android.ts';
import { drawOverlayRef } from './screenshot-overlay-draw.ts';
import {
  clamp,
  hasPositiveRect,
  rectArea,
  rectContains,
} from '../snapshot/screenshot-overlay/rects.ts';

const MAX_OVERLAY_REFS = 24;
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

function resolveOverlayTarget(
  nodes: SnapshotState['nodes'],
  node: SnapshotNode,
): SnapshotNode | null {
  return (
    [
      isOverlayActionableNode(node) ? node : null,
      findNearestAncestor(nodes, node, isOverlayActionableNode),
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
  const space = snapshot.backend === 'android' ? 'device-pixels' : 'viewport-points';
  return clampRect(
    projectSnapshotRectToScreenshot(space, bounds, rect, screenshotWidth, screenshotHeight),
    screenshotWidth,
    screenshotHeight,
  );
}

function hasActionableRole(node: SnapshotNode): boolean {
  const roleText = [node.type, node.role, node.subrole]
    .map((value) => normalizeType(value ?? ''))
    .join(' ');
  return ACTIONABLE_ROLE_TYPES.some((type) => roleText.includes(type));
}

function isOverlayActionableNode(node: SnapshotNode): boolean {
  return hasActionableRole(node) && !isViewportRootNode(node);
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

function isUsableOverlayTarget(node: SnapshotNode | null): node is SnapshotNode {
  return Boolean(node?.rect && hasPositiveRect(node.rect) && !isViewportRootNode(node));
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
