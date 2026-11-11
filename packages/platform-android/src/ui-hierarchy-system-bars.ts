import { androidSystemBarMembership } from '@agent-device/contracts/android-system-chrome';
import type { Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect, rectContains } from '@agent-device/kernel/rect';
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
  const bars: SystemBar[] = [];
  const barRoots = new Set<AndroidNode>();
  for (const root of roots) {
    const pending = [root];
    while (pending.length > 0) {
      budget.check('work');
      const node = pending.pop()!;
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
      pending.push(...node.children);
    }
  }
  const clips = new Map<AndroidNode, Rect>();
  for (const root of roots) {
    if (barRoots.has(root)) continue;
    const frame = root.windowRect ?? viewport;
    if (!isPositiveFiniteRect(frame)) continue;
    let clip = frame;
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
    if (clip !== frame) clips.set(root, clip);
  }
  return clips;
}

function clipSystemBar(frame: Rect, bar: Rect): Rect {
  if (rectContains(bar, frame)) return { ...frame, width: 0, height: 0 };
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  const barRight = bar.x + bar.width;
  const barBottom = bar.y + bar.height;
  if (bar.x <= frame.x && barRight >= right && bar.height < frame.height) {
    if (bar.y <= frame.y && barBottom > frame.y) {
      return { ...frame, y: barBottom, height: bottom - barBottom };
    }
    if (bar.y < bottom && barBottom >= bottom) {
      return { ...frame, height: bar.y - frame.y };
    }
  }
  if (bar.y <= frame.y && barBottom >= bottom && bar.width < frame.width) {
    if (bar.x <= frame.x && barRight > frame.x) {
      return { ...frame, x: barRight, width: right - barRight };
    }
    if (bar.x < right && barRight >= right) {
      return { ...frame, width: bar.x - frame.x };
    }
  }
  return frame;
}
