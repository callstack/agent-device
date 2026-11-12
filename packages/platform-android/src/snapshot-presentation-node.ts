import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { intersectRects, isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { androidSystemBarMembership } from '@agent-device/contracts/android-system-chrome';
import type { AndroidNode } from './ui-hierarchy-node.ts';
import type { AndroidSnapshotPresentationBudget } from './snapshot-presentation.ts';

/**
 * The typed carrier between acquisition facts and a regular snapshot projection.
 *
 * `raw.rect` remains the backend-reported frame for raw output and traversal. A regular
 * projection must publish `effectiveRect`, after the owning presentation policy has folded its
 * viewport and ancestor clips. Keeping both values in one contract prevents an adapter from
 * accidentally publishing acquisition geometry as presented geometry (#1797, #1983).
 */
export type SnapshotPresentationNode = {
  raw: RawSnapshotNode;
  effectiveRect?: Rect;
};

export function createSnapshotPresentationNode(
  raw: RawSnapshotNode,
  effectiveRect?: Rect,
): SnapshotPresentationNode {
  return {
    raw,
    ...(effectiveRect ? { effectiveRect } : {}),
  };
}

/**
 * Folds a reported frame through the viewport and the nearest effective ancestor clip.
 * Empty intersections preserve the reported origin and become zero-area frames, so diagnostics
 * retain useful coordinates while regular actionability can fail closed.
 */
export function foldSnapshotRect(
  reportedRect: Rect | undefined,
  viewport: Rect | undefined,
  ancestorClip: Rect | undefined,
): Rect | undefined {
  if (!reportedRect) return undefined;
  let effective = normalizeRect(reportedRect);
  if (viewport) effective = intersectRect(effective, viewport);
  if (ancestorClip) effective = intersectRect(effective, ancestorClip);
  return effective;
}

/** Serializes one regular node without allowing its reported frame to cross the presentation seam. */
export function serializeRegularSnapshotPresentationNode(
  node: SnapshotPresentationNode,
): RawSnapshotNode {
  return {
    ...node.raw,
    ...(node.effectiveRect ? { rect: node.effectiveRect } : { rect: undefined }),
    hittable:
      node.raw.hittable === true && isPositiveFiniteRect(node.effectiveRect) ? true : undefined,
  };
}

function intersectRect(left: Rect, right: Rect): Rect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  const hasIntersection = maxX > x && maxY > y;
  return {
    x: hasIntersection ? x : left.x,
    y: hasIntersection ? y : left.y,
    width: hasIntersection ? maxX - x : 0,
    height: hasIntersection ? maxY - y : 0,
  };
}

function normalizeRect(rect: Rect): Rect {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
  };
}

type SystemBar = { root: AndroidNode; rect: Rect };

export type AndroidSystemBarContentClip = Readonly<{
  inputBounds: Rect;
  hasBarDescendants: boolean;
}>;

/** The visible window clips left by measured persistent Android bars, including launcher-owned navigation. */
export function androidSystemBarContentClips(
  roots: readonly AndroidNode[],
  hidden: ReadonlySet<AndroidNode>,
  viewport: Rect | undefined,
  budget: AndroidSnapshotPresentationBudget,
): ReadonlyMap<AndroidNode, AndroidSystemBarContentClip> {
  const { bars, barAncestors } = collectSystemBars(roots, hidden, budget);
  const clips = new Map<AndroidNode, AndroidSystemBarContentClip>();
  for (const root of roots) {
    const frame = root.windowRect ?? viewport;
    if (!isPositiveFiniteRect(frame)) continue;
    const clip = clipWindowToSystemBars(root, frame, bars, budget);
    if (clip === frame) continue;
    const contentClip = { inputBounds: clip, hasBarDescendants: false };
    const ancestorClip = { inputBounds: clip, hasBarDescendants: true };
    const pending = [root];
    while (pending.length > 0) {
      budget.check('work');
      const node = pending.pop()!;
      clips.set(node, barAncestors.has(node) ? ancestorClip : contentClip);
      pending.push(...node.children);
    }
  }
  return clips;
}

function clipWindowToSystemBars(
  root: AndroidNode,
  frame: Rect,
  bars: readonly SystemBar[],
  budget: AndroidSnapshotPresentationBudget,
): Rect {
  let clip = frame;
  let previous: Rect;
  do {
    previous = clip;
    for (const bar of bars) {
      budget.check('work');
      if (
        bar.root !== root &&
        root.windowLayer !== undefined &&
        bar.root.windowLayer !== undefined &&
        bar.root.windowLayer <= root.windowLayer
      ) {
        continue;
      }
      clip = clipSystemBar(clip, bar.rect);
    }
  } while (clip !== previous);
  return clip;
}

function collectSystemBars(
  roots: readonly AndroidNode[],
  hidden: ReadonlySet<AndroidNode>,
  budget: AndroidSnapshotPresentationBudget,
): { bars: SystemBar[]; barAncestors: Set<AndroidNode> } {
  const bars: SystemBar[] = [];
  const barAncestors = new Set<AndroidNode>();
  const parents = new Map<AndroidNode, AndroidNode>();
  const pending = roots.map((root) => ({ root, node: root }));
  while (pending.length > 0) {
    budget.check('work');
    const { root, node } = pending.pop()!;
    if (hidden.has(node)) continue;
    const barRect = foldSnapshotRect(node.rect, node.windowRect ?? root.windowRect, undefined);
    if (
      node.visibleToUser !== false &&
      androidSystemBarMembership(node.packageName, node.identifier) !== undefined &&
      isPositiveFiniteRect(barRect)
    ) {
      bars.push({ root, rect: barRect });
      markSystemBarAncestors(parents.get(node), parents, barAncestors, budget);
    }
    pending.push(
      ...node.children.map((child) => {
        parents.set(child, node);
        return { root, node: child };
      }),
    );
  }
  return { bars, barAncestors };
}

function markSystemBarAncestors(
  node: AndroidNode | undefined,
  parents: ReadonlyMap<AndroidNode, AndroidNode>,
  ancestors: Set<AndroidNode>,
  budget: AndroidSnapshotPresentationBudget,
): void {
  while (node && !ancestors.has(node)) {
    budget.check('work');
    ancestors.add(node);
    node = parents.get(node);
  }
}

function clipSystemBar(frame: Rect, bar: Rect): Rect {
  const covered = intersectRects(frame, bar);
  if (!covered) return frame;
  if (covered.width === frame.width) {
    if (covered.y === frame.y) {
      return { ...frame, y: frame.y + covered.height, height: frame.height - covered.height };
    }
    if (covered.y + covered.height === frame.y + frame.height) {
      return { ...frame, height: covered.y - frame.y };
    }
  }
  if (covered.height === frame.height) {
    if (covered.x === frame.x) {
      return { ...frame, x: frame.x + covered.width, width: frame.width - covered.width };
    }
    if (covered.x + covered.width === frame.x + frame.width) {
      return { ...frame, width: covered.x - frame.x };
    }
  }
  return frame;
}
