import { centerOfRect, type SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  findBestMatchesByLocator,
  type FindLocator,
  type SelectorMatchOptions,
} from '@agent-device/selectors';
import {
  createActionableTouchResolver,
  isRootInteractionContainer,
  resolveActionableTouchResolution,
} from './interaction-targeting.ts';
import { listSelectorPipelineMatches } from './selector-pipeline.ts';
import { SELECTOR_PIPELINE_POLICIES } from './selector-pipeline-policy.ts';

/**
 * The candidate set of every `find` action that binds one node: mutating actions and the value
 * reads (`get text`, `get attrs`). The root interaction container is never a candidate, and
 * on-screen matches rank first. Callers count this list and narrow it with `narrowFindMatches`,
 * so a read and a tap on the same query bind the same node.
 */
export function findOneNodeCandidates(params: {
  nodes: SnapshotNode[];
  locator: FindLocator;
  query: string;
  selectorExpression: string | null;
  platform: SelectorMatchOptions['platform'];
}): SnapshotNode[] {
  const { nodes, locator, query, selectorExpression, platform } = params;
  const pipeline = SELECTOR_PIPELINE_POLICIES.findAct;
  const rooted = nodes.filter((node) => !isRootInteractionContainer(node, nodes[0]));
  const matches = selectorExpression
    ? (listSelectorPipelineMatches(pipeline, rooted, selectorExpression, { platform }).list
        ?.matchedNodes ?? [])
    : findBestMatchesByLocator(rooted, locator, query, {
        requireRect: pipeline.resolution.requireRect,
      }).matches;
  return preferOnscreenMatches(matches, nodes);
}

/**
 * How `find` orders the candidates its locator matched. Ordering is a separate question from
 * matching: it asks which candidate an agent most plausibly meant to touch, using the same
 * actionability policy the interaction itself will run.
 */
export function preferOnscreenMatches(
  matches: SnapshotNode[],
  nodes: SnapshotNode[],
): SnapshotNode[] {
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
  matches: SnapshotNode[],
  nodes: SnapshotNode[],
  resolveTouch: ReturnType<typeof createActionableTouchResolver>,
): SnapshotNode[] {
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
  node: SnapshotNode,
  nodes: SnapshotNode[],
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
  root: SnapshotNode | undefined,
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

function rectArea(node: SnapshotNode): number {
  return node.rect ? node.rect.width * node.rect.height : Number.POSITIVE_INFINITY;
}
