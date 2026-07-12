import type { Rect, SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import {
  buildSnapshotNodeByIndex,
  findSnapshotAncestor,
  isDescendantOfSnapshotNode,
  normalizeType,
} from '../../snapshot/snapshot-processing.ts';
import {
  maestroVisibleTextMatchRank,
  type MaestroPreferredContext,
  type MaestroResolvedSnapshotMatch,
} from './runtime-target-policy.ts';
import {
  rectArea,
  rectContains,
  rectOverlapRatio,
  type SnapshotNodeByIndex,
} from './runtime-target-ranking-geometry.ts';

type MaestroMatchWithScreenContainer = {
  candidate: MaestroResolvedSnapshotMatch;
  container: SnapshotNode & { rect: Rect };
};

export function selectPreferredMaestroSnapshotMatch(
  nodes: SnapshotState['nodes'],
  candidates: MaestroResolvedSnapshotMatch[],
  visibleTextQuery: string | null,
  promoteTapTarget: boolean,
  preferredContext?: MaestroPreferredContext,
): MaestroResolvedSnapshotMatch | null {
  if (!promoteTapTarget || !visibleTextQuery) {
    return selectBestMaestroSnapshotMatch(nodes, candidates, visibleTextQuery, preferredContext);
  }
  return (
    selectLocalizedMaestroVisibleTextMatch(nodes, candidates, visibleTextQuery, preferredContext) ??
    selectBestMaestroSnapshotMatch(nodes, candidates, visibleTextQuery, preferredContext)
  );
}

function selectBestMaestroSnapshotMatch(
  nodes: SnapshotState['nodes'],
  candidates: MaestroResolvedSnapshotMatch[],
  visibleTextQuery: string | null,
  preferredContext?: MaestroPreferredContext,
): MaestroResolvedSnapshotMatch | null {
  const foregroundCandidates = preferForegroundContainerDuplicateMatches(
    nodes,
    candidates,
    visibleTextQuery,
    preferredContext,
  );
  return (
    foregroundCandidates.sort((left, right) =>
      compareMaestroSnapshotMatches(left, right, visibleTextQuery),
    )[0] ?? null
  );
}

function selectLocalizedMaestroVisibleTextMatch(
  nodes: SnapshotState['nodes'],
  candidates: MaestroResolvedSnapshotMatch[],
  query: string,
  preferredContext?: MaestroPreferredContext,
): MaestroResolvedSnapshotMatch | null {
  const exactMatches = candidates.filter(
    (candidate) => maestroVisibleTextMatchRank(candidate.node, query) === 0,
  );
  if (exactMatches.length >= 2) {
    const localizedExact = selectLocalizedMaestroVisibleTextMatchFromCandidates(
      nodes,
      exactMatches,
      query,
      preferredContext,
    );
    if (localizedExact) return localizedExact;
  }

  const normalizedMatches = candidates.filter(
    (candidate) => maestroVisibleTextMatchRank(candidate.node, query) === 1,
  );
  if (exactMatches.length > 0 || normalizedMatches.length < 2) return null;

  return selectLocalizedMaestroVisibleTextMatchFromCandidates(
    nodes,
    normalizedMatches,
    query,
    preferredContext,
  );
}

function selectLocalizedMaestroVisibleTextMatchFromCandidates(
  nodes: SnapshotState['nodes'],
  candidates: MaestroResolvedSnapshotMatch[],
  query: string,
  preferredContext?: MaestroPreferredContext,
): MaestroResolvedSnapshotMatch | null {
  const nodeByIndex = buildSnapshotNodeByIndex(nodes);
  const localized = candidates.filter(
    (candidate) =>
      isLocalizedMaestroVisibleTextCandidate(candidate) &&
      candidates.some((container) =>
        isMaestroVisibleTextContainerForCandidate(nodes, container, candidate, nodeByIndex),
      ),
  );

  return selectBestMaestroSnapshotMatch(nodes, localized, query, preferredContext);
}

// fallow-ignore-next-line complexity
function preferForegroundContainerDuplicateMatches(
  nodes: SnapshotState['nodes'],
  candidates: MaestroResolvedSnapshotMatch[],
  visibleTextQuery: string | null,
  preferredContext?: MaestroPreferredContext,
): MaestroResolvedSnapshotMatch[] {
  if (!visibleTextQuery || candidates.length < 2) return candidates;
  const exact = candidates.filter(
    (candidate) => maestroVisibleTextMatchRank(candidate.node, visibleTextQuery) === 0,
  );
  if (exact.length < 2) return candidates;

  const nodeByIndex = buildSnapshotNodeByIndex(nodes);
  const withContainers = exact
    .map((candidate) => ({
      candidate,
      container: findMaestroScreenContainer(nodes, candidate.node, nodeByIndex),
    }))
    .filter((entry): entry is MaestroMatchWithScreenContainer => Boolean(entry.container));
  if (withContainers.length < 2 || withContainers.length !== exact.length) return candidates;

  const overlapping = withContainers.filter((entry) =>
    hasOverlappingScreenContainer(entry, withContainers),
  );
  if (overlapping.length < 2) return candidates;

  const foregroundByArea = selectLargestOverlappingScreenContainerMatches(overlapping);
  if (foregroundByArea.length > 0) return foregroundByArea;

  const foregroundByContext = selectContextualOverlappingScreenContainerMatches(
    nodes,
    overlapping,
    preferredContext,
    nodeByIndex,
  );
  if (foregroundByContext.length > 0) return foregroundByContext;

  // UIAutomator reports foreground transparent-stack screens later in the
  // hierarchy while preserving both screens. Prefer the later overlapping
  // screen only for exact duplicate text, so ordinary duplicate rows keep
  // Maestro's read-order behavior.
  const foregroundContainerIndex = Math.max(...overlapping.map((entry) => entry.container.index));
  const foreground = overlapping
    .filter((entry) => entry.container.index === foregroundContainerIndex)
    .map((entry) => entry.candidate);
  return foreground.length > 0 ? foreground : candidates;
}

function selectContextualOverlappingScreenContainerMatches(
  nodes: SnapshotState['nodes'],
  entries: MaestroMatchWithScreenContainer[],
  context: MaestroPreferredContext | undefined,
  nodeByIndex: SnapshotNodeByIndex,
): MaestroResolvedSnapshotMatch[] {
  if (!context) return [];
  const rawContextContainer = findMaestroScreenContainer(nodes, context.node, nodeByIndex);
  const contextContainer =
    rawContextContainer && rectContains(rawContextContainer.rect, context.rect)
      ? rawContextContainer
      : null;
  const scored = entries.map((entry) => ({
    entry,
    score: scoreScreenContainerAgainstContext(entry.container, context, contextContainer),
  }));
  const bestScore = Math.min(...scored.map((entry) => entry.score));
  if (!Number.isFinite(bestScore)) return [];
  return scored.filter((entry) => entry.score === bestScore).map((entry) => entry.entry.candidate);
}

function scoreScreenContainerAgainstContext(
  container: SnapshotNode & { rect: Rect },
  context: MaestroPreferredContext,
  contextContainer: (SnapshotNode & { rect: Rect }) | null,
): number {
  if (contextContainer) {
    if (container.index === contextContainer.index) return 0;
    if (rectOverlapRatio(container.rect, contextContainer.rect) < 0.6)
      return Number.POSITIVE_INFINITY;
    return Math.abs(container.index - contextContainer.index);
  }

  if (rectOverlapRatio(container.rect, context.rect) >= 0.6) return 0;
  const orderDistance = container.index - context.node.index;
  return orderDistance >= 0 ? orderDistance : 100_000 + Math.abs(orderDistance);
}

function selectLargestOverlappingScreenContainerMatches(
  entries: MaestroMatchWithScreenContainer[],
): MaestroResolvedSnapshotMatch[] {
  const areas = entries.map((entry) => rectArea(entry.container.rect));
  const largestArea = Math.max(...areas);
  const smallestArea = Math.min(...areas);
  if (smallestArea <= 0 || largestArea < smallestArea * 1.2) return [];
  return entries
    .filter((entry) => rectArea(entry.container.rect) === largestArea)
    .map((entry) => entry.candidate);
}

function hasOverlappingScreenContainer(
  entry: MaestroMatchWithScreenContainer,
  candidates: MaestroMatchWithScreenContainer[],
): boolean {
  return candidates.some(
    (other) =>
      other !== entry &&
      entry.container.index !== other.container.index &&
      rectOverlapRatio(entry.container.rect, other.container.rect) >= 0.6,
  );
}

function findMaestroScreenContainer(
  nodes: SnapshotState['nodes'],
  node: SnapshotNode,
  nodeByIndex: SnapshotNodeByIndex,
): (SnapshotNode & { rect: Rect }) | null {
  return findSnapshotAncestor(nodes, node, nodeByIndex, (ancestor) => {
    if (!ancestor.rect) return null;
    if (!isMaestroScreenContainerType(ancestor)) return null;
    if (ancestor.rect.width < 240 || ancestor.rect.height < 320) return null;
    return ancestor as SnapshotNode & { rect: Rect };
  });
}

function isMaestroScreenContainerType(node: SnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  return type === 'scrollview' || type === 'scroll-area' || type === 'list';
}

function isLocalizedMaestroVisibleTextCandidate(match: MaestroResolvedSnapshotMatch): boolean {
  return (
    match.rect.width >= 16 &&
    match.rect.width <= 260 &&
    match.rect.height >= 24 &&
    match.rect.height <= 80
  );
}

function isMaestroVisibleTextContainerForCandidate(
  nodes: SnapshotState['nodes'],
  container: MaestroResolvedSnapshotMatch,
  candidate: MaestroResolvedSnapshotMatch,
  nodeByIndex: SnapshotNodeByIndex,
): boolean {
  if (container.node.index === candidate.node.index) return false;
  if (!rectContains(container.rect, candidate.rect)) return false;
  if (rectArea(container.rect) < rectArea(candidate.rect) * 2) return false;
  return isDescendantOfSnapshotNode(nodes, candidate.node, container.node, nodeByIndex);
}

function compareMaestroSnapshotMatches(
  left: MaestroResolvedSnapshotMatch,
  right: MaestroResolvedSnapshotMatch,
  visibleTextQuery: string | null,
): number {
  const priorityRank = compareMaestroSnapshotMatchPriority(left, right, visibleTextQuery);
  if (priorityRank !== 0) return priorityRank;

  if (!sameRoundedRect(left.rect, right.rect)) {
    return left.node.index - right.node.index;
  }

  const depthRank = (right.node.depth ?? 0) - (left.node.depth ?? 0);
  if (depthRank !== 0) return depthRank;

  // Android transparent stacks can expose both the background screen and the
  // foreground screen at the same coordinates. UIAutomator reports the
  // foreground duplicate later in the snapshot, which matches Maestro's
  // practical tap target for overlapping duplicates.
  return right.node.index - left.node.index;
}

function compareMaestroSnapshotMatchPriority(
  left: MaestroResolvedSnapshotMatch,
  right: MaestroResolvedSnapshotMatch,
  visibleTextQuery: string | null,
): number {
  if (visibleTextQuery) {
    const textRank =
      maestroVisibleTextMatchRank(left.node, visibleTextQuery) -
      maestroVisibleTextMatchRank(right.node, visibleTextQuery);
    if (textRank !== 0) return textRank;
  }

  const typeRank = maestroTapTargetTypeRank(left.node) - maestroTapTargetTypeRank(right.node);
  if (typeRank !== 0) return typeRank;

  const rectSourceRank = Number(left.inheritedRect) - Number(right.inheritedRect);
  if (rectSourceRank !== 0) return rectSourceRank;

  const areaRank =
    visibleTextQuery && maestroTapTargetTypeRank(left.node) === maestroTapTargetTypeRank(right.node)
      ? rectArea(right.rect) - rectArea(left.rect)
      : rectArea(left.rect) - rectArea(right.rect);
  if (areaRank !== 0) return areaRank;
  return 0;
}

function sameRoundedRect(left: Rect, right: Rect): boolean {
  return (
    Math.round(left.x) === Math.round(right.x) &&
    Math.round(left.y) === Math.round(right.y) &&
    Math.round(left.width) === Math.round(right.width) &&
    Math.round(left.height) === Math.round(right.height)
  );
}

function maestroTapTargetTypeRank(node: SnapshotNode): number {
  return MAESTRO_TAP_TARGET_TYPE_RANK.get(normalizeType(node.type ?? '')) ?? 3;
}

const MAESTRO_TAP_TARGET_TYPE_RANK = new Map([
  ['button', 0],
  ['link', 0],
  ['textfield', 0],
  ['textview', 0],
  ['searchfield', 0],
  ['switch', 0],
  ['slider', 0],
  ['cell', 1],
  ['statictext', 2],
]);
