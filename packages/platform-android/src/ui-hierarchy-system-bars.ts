import { androidSystemBarMembership } from '@agent-device/contracts/android-system-chrome';
import type { Rect } from '@agent-device/kernel/snapshot';
import { intersectRects, isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { foldSnapshotRect } from './snapshot-presentation-node.ts';
import type { AndroidNode } from './ui-hierarchy-node.ts';
import type { AndroidSnapshotPresentationBudget } from './snapshot-presentation.ts';

type SystemBar = { root: AndroidNode; rect: Rect };

/** The visible window clips left by measured persistent Android bars, including launcher-owned navigation. */
export function androidSystemBarContentClips(
  roots: readonly AndroidNode[],
  hidden: ReadonlySet<AndroidNode>,
  viewport: Rect | undefined,
  budget: AndroidSnapshotPresentationBudget,
): ReadonlyMap<AndroidNode, Rect> {
  const { bars, barRoots } = collectSystemBars(roots, hidden, budget);
  const clips = new Map<AndroidNode, Rect>();
  for (const root of roots) {
    if (barRoots.has(root)) continue;
    const frame = root.windowRect ?? viewport;
    if (!isPositiveFiniteRect(frame)) continue;
    const clip = clipWindowToSystemBars(root, frame, bars, budget);
    if (clip !== frame) clips.set(root, clip);
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
): { bars: SystemBar[]; barRoots: Set<AndroidNode> } {
  const bars: SystemBar[] = [];
  const barRoots = new Set<AndroidNode>();
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
      barRoots.add(root);
    }
    pending.push(...node.children.map((child) => ({ root, node: child })));
  }
  return { bars, barRoots };
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
