import { centerOfRect, type SnapshotState } from '@agent-device/kernel/snapshot';
import {
  createActionableTouchResolver,
  isRootInteractionContainer,
  resolveActionableTouchResolution,
} from '../../../core/interaction-targeting.ts';

/**
 * How `find` orders the candidates its locator matched, before the ambiguity
 * contract in `find-match-resolution.ts` either refuses them or narrows with
 * `--first`/`--last`. Ordering is a separate question from matching: it asks
 * which candidate an agent most plausibly meant to touch, using the same
 * actionability policy the interaction itself will run.
 */
export function preferOnscreenMatches(
  matches: SnapshotState['nodes'],
  nodes: SnapshotState['nodes'],
): SnapshotState['nodes'] {
  const viewport = nodes[0]?.rect;
  if (!viewport) return matches;
  const onscreen = matches.filter((node) => {
    if (!node.rect) return false;
    const center = centerOfRect(node.rect);
    return (
      center.x >= viewport.x &&
      center.x <= viewport.x + viewport.width &&
      center.y >= viewport.y &&
      center.y <= viewport.y + viewport.height
    );
  });
  const preferred = onscreen.length > 0 ? onscreen : matches;
  if (preferred.length < 2) return preferred;
  return rankInteractiveMatches(preferred, nodes, createActionableTouchResolver(nodes));
}

function rankInteractiveMatches(
  matches: SnapshotState['nodes'],
  nodes: SnapshotState['nodes'],
  resolveTouch: ReturnType<typeof createActionableTouchResolver>,
): SnapshotState['nodes'] {
  return matches
    .map((node, index) => ({
      node,
      index,
      score: interactiveMatchScore(node, nodes, resolveTouch),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return rectArea(left.node) - rectArea(right.node) || left.index - right.index;
    })
    .map((entry) => entry.node);
}

function interactiveMatchScore(
  node: SnapshotState['nodes'][number],
  nodes: SnapshotState['nodes'],
  resolveTouch: ReturnType<typeof createActionableTouchResolver>,
): number {
  const resolution = resolveTouch(node);
  if (resolution.reason === 'covered') return 0;
  const resolved = resolvedTouchScore(resolution, nodes[0]);
  if (resolved > 0) return resolved;
  if (node.hittable && node.rect && !isRootInteractionContainer(node, nodes[0])) return 3;
  return node.rect ? 1 : 0;
}

function resolvedTouchScore(
  resolution: ReturnType<typeof resolveActionableTouchResolution>,
  root: SnapshotState['nodes'][number] | undefined,
): number {
  if (!resolution.node.rect) return 0;
  if (resolution.reason === 'semantic-target' || resolution.reason === 'same-rect-descendant') {
    return 4;
  }
  if (
    resolution.reason === 'hittable-ancestor' &&
    !isRootInteractionContainer(resolution.node, root)
  ) {
    return 2;
  }
  return 0;
}

function rectArea(node: SnapshotState['nodes'][number]): number {
  return node.rect ? node.rect.width * node.rect.height : Number.POSITIVE_INFINITY;
}
