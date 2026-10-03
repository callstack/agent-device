export { isScrollableNodeLike, isScrollableType } from '../snapshot-scroll.ts';
export {
  findSnapshotScopeRange,
  matchesSnapshotScope,
  normalizeSnapshotScope,
  reindexSnapshotNodes,
  type SnapshotScopeCandidate,
} from '../snapshot-scope.ts';
export {
  buildSnapshotNodeMap,
  findNearestAncestor,
  findSnapshotAncestor,
} from '../snapshot-tree.ts';
export {
  collectViewportRects,
  createSnapshotVisibility,
  findNearestScrollableAncestor,
  isUsefulVisibilityAnchor,
  isViewportRootNode,
  isTapPointInsideViewport,
  resolveViewportRect,
  type SnapshotVisibility,
  type SnapshotVisibilityProbe,
} from '../snapshot-visibility.ts';
export {
  extractNodeText,
  isFillableType,
  isMeaningfulLabel,
  isMeaningfulSignal,
  normalizeType,
} from '../snapshot-text.ts';
