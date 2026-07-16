/**
 * #1280, ADR 0012 decision 3 amendment: record-time retarget of an
 * identity-empty press container to its first labeled descendant, so the
 * RECORDED selector chain and `target-v1` evidence both key off a node with
 * selective identity instead of a bare shared role (e.g. Android's
 * label-less `role="linearlayout"` list row, whose title lives on a child
 * `TextView`). See docs/adr/0012-interactive-replay.md decision 3.
 *
 * Recording-only side channel: the caller
 * (`describeResolvedInteractionNode`, resolution.ts) keeps the live response
 * entirely container-based and carries this result on
 * `recordingTarget` — consumed exclusively at the recording boundary
 * (`interaction-touch-response.ts`), never in the wire response.
 */
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { containsPoint } from '../utils/rect-visibility.ts';
import { resolveRectCenter } from '../utils/rect-center.ts';
import {
  demoteNonUniqueLocalIdentity,
  readNodeLocalIdentity,
} from '../replay/target-identity-node.ts';
import { normalizeSelectorText } from '../selectors/build.ts';
import { isSemanticTouchTarget } from './interaction-targeting.ts';

/**
 * Rule 3's fail-closed guard: a descendant that could independently receive
 * the tap — a trailing Switch/Checkbox on a list row is the measured risk
 * shape. `isSemanticTouchTarget` is the repo's ONE interactive-role
 * classification (interaction-targeting.ts); the `hittable === true` clause
 * additionally blocks on any platform-flagged tappable, whatever its role.
 */
function isCompetingInteractive(node: SnapshotNode): boolean {
  return node.hittable === true || isSemanticTouchTarget(node);
}

/**
 * Identity-empty (#1280 rule 1), evaluated from the DEMOTED identity view:
 * no id SURVIVING #1269's demotion (absent, or demoted for being non-unique
 * in the record-time tree), no label, no value. The demoted view is the
 * point — `extractNodeText`'s raw-identifier fallback must not resurrect an
 * id that did not survive demotion, or a container carrying a duplicated id
 * would read as identity-bearing and skip the retarget it needs most.
 */
function isIdentityEmpty(node: SnapshotNode, nodes: readonly SnapshotNode[]): boolean {
  const identity = demoteNonUniqueLocalIdentity(readNodeLocalIdentity(node), nodes);
  if (identity.id !== undefined || identity.label !== undefined) return false;
  return normalizeSelectorText(node.value) === null;
}

function buildIndexMap(nodes: readonly SnapshotNode[]): Map<number, SnapshotNode> {
  const map = new Map<number, SnapshotNode>();
  for (const node of nodes) map.set(node.index, node);
  return map;
}

/** True when `node` is a proper descendant of `root` — a cycle-safe parent walk, matching `buildAncestryChain`'s guard. */
function isDescendantOf(
  node: SnapshotNode,
  root: SnapshotNode,
  byIndex: Map<number, SnapshotNode>,
): boolean {
  const visited = new Set<number>();
  let current = node;
  while (typeof current.parentIndex === 'number') {
    if (visited.has(current.index)) return false;
    visited.add(current.index);
    if (current.parentIndex === root.index) return true;
    const parent = byIndex.get(current.parentIndex);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

/** `root`'s whole subtree, ordered by document order (decision 3's canonical total order — `node.index`). */
function collectSubtree(root: SnapshotNode, nodes: readonly SnapshotNode[]): SnapshotNode[] {
  const byIndex = buildIndexMap(nodes);
  return nodes
    .filter((node) => node.index !== root.index && isDescendantOf(node, root, byIndex))
    .sort((a, b) => a.index - b.index);
}

/**
 * Geometry half of the guard: the replay tap lands at the DESCENDANT's rect
 * center, so that center must provably lie inside the original container's
 * rect — the activation region the recorded press actually hit. Missing
 * rects fail closed (no retarget).
 */
function isCenterInsideContainer(descendant: SnapshotNode, container: SnapshotNode): boolean {
  const center = resolveRectCenter(descendant.rect);
  if (!center || !container.rect) return false;
  return containsPoint(container.rect, center.x, center.y);
}

/**
 * #1280 rules 1-3: when `node` is an identity-empty press container whose
 * subtree contains no competing interactive/hittable node, returns its first
 * labeled descendant in document order — provided that descendant's rect
 * center lies inside the container's rect. Returns `node` unchanged when it
 * isn't identity-empty, the guard blocks, no descendant carries a label, or
 * the geometry check fails — recording proceeds exactly as today in all
 * those cases.
 */
export function resolvePressRecordingTarget(
  node: SnapshotNode,
  nodes: readonly SnapshotNode[],
): SnapshotNode {
  if (!isIdentityEmpty(node, nodes)) return node;
  const subtree = collectSubtree(node, nodes);
  if (subtree.some(isCompetingInteractive)) return node;
  const labeledDescendant = subtree.find(
    (candidate) => readNodeLocalIdentity(candidate).label !== undefined,
  );
  if (!labeledDescendant || !isCenterInsideContainer(labeledDescendant, node)) return node;
  return labeledDescendant;
}
