/**
 * #1280, ADR 0012 decision 3 amendment: record-time retarget of an
 * identity-empty press container to its first labeled descendant, so the
 * recorded selector chain and `target-v1` evidence both key off a node with
 * selective identity instead of a bare shared role (e.g. Android's
 * label-less `role="linearlayout"` list row, whose title lives on a child
 * `TextView`). See docs/adr/0012-interactive-replay.md decision 3.
 *
 * Recording-time only: the caller (`describeResolvedInteractionNode`,
 * `src/commands/interaction/runtime/resolution.ts`) already fixed the live
 * tap point against the ORIGINAL node before this runs — this only changes
 * which node gets WRITTEN to session history / the `.ad` script.
 */
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { extractNodeText } from '../snapshot/snapshot-processing.ts';
import {
  demoteNonUniqueLocalIdentity,
  readNodeLocalIdentity,
} from '../replay/target-identity-node.ts';
import { normalizeSelectorText } from './build.ts';

// Rule 3's fail-closed guard: a descendant carrying one of these could be
// independently activated by a tap at ITS center rather than the
// container's — a trailing Switch/Checkbox on a list row is the measured
// risk shape. Their presence anywhere in the subtree blocks retargeting.
const COMPETING_INTERACTIVE_TYPE_FRAGMENTS = [
  'button',
  'checkbox',
  'switch',
  'radio',
  'link',
  'textfield',
  'edittext',
  'searchfield',
  'menuitem',
];

function isCompetingInteractive(node: SnapshotNode): boolean {
  if (node.hittable === true) return true;
  const type = (node.type ?? '').toLowerCase();
  return COMPETING_INTERACTIVE_TYPE_FRAGMENTS.some((fragment) => type.includes(fragment));
}

/** No surviving id (absent, or demoted per #1269), no label, no value/text — nothing a selector could key on besides bare role. */
function isIdentityEmpty(node: SnapshotNode, nodes: readonly SnapshotNode[]): boolean {
  const identity = demoteNonUniqueLocalIdentity(readNodeLocalIdentity(node), nodes);
  if (identity.id !== undefined || identity.label !== undefined) return false;
  if (normalizeSelectorText(node.value)) return false;
  if (normalizeSelectorText(extractNodeText(node))) return false;
  return true;
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
 * #1280 rules 1-3: when `node` is an identity-empty press container whose
 * subtree contains no other interactive/hittable node, returns its first
 * labeled descendant in document order. Returns `node` unchanged when it
 * isn't identity-empty, the guard blocks (a competing interactive
 * descendant exists), or no descendant carries a label — recording proceeds
 * exactly as today in all three cases.
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
  return labeledDescendant ?? node;
}
