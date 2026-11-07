export { isScrollableNodeLike, isScrollableType } from '../snapshot-scroll.ts';
export {
  findSnapshotScopeRange,
  matchesSnapshotScope,
  normalizeSnapshotScope,
  reindexSnapshotNodes,
  type SnapshotScopeCandidate,
} from '../snapshot-scope.ts';
export {
  snapshotStateProvenance,
  isSnapshotBackend,
  usesMobileSnapshotPresentation,
  inheritPostGestureOutcome,
  snapshotRefMinting,
  buildSnapshotNodeMap,
  findSnapshotAncestor,
  findNearestAncestor,
  type SnapshotProvenance,
  type SnapshotBackend,
  type SnapshotProducer,
  type SnapshotStateProvenance,
  type SnapshotCaptureProvenance,
  type SnapshotState,
  type PostGestureAction,
  type PostGestureOutcome,
} from '../snapshot-model.ts';
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
  androidFieldValue,
  extractNodeText,
  isFillableType,
  isMeaningfulLabel,
  isMeaningfulSignal,
  normalizeType,
} from '../snapshot-text.ts';
