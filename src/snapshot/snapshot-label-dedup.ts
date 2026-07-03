import type { SnapshotNode } from '../kernel/snapshot.ts';
import { buildSnapshotNodeMap } from './snapshot-tree.ts';

/**
 * Output-only label/identifier dedup: when a node's `label` (or, separately,
 * `identifier`) is string-equal to the nearest ancestor's in its parent chain
 * (via `parentIndex`), replace the value with an `inheritsLabel`/`inheritsIdentifier`
 * marker instead of repeating the string.
 *
 * Deep RN/AX trees inherit the same accessibility label across several wrapper
 * nodes (ScrollView -> Other -> Button -> inner Button), so a long label can be
 * repeated 3-4x in a single snapshot. This collapses those repeats for the
 * CLI/JSON client output only.
 *
 * This must run strictly at the client-serialization boundary. The in-daemon
 * session tree (used by selector building, wait/is/get matching, and replay)
 * must keep the original, non-deduped labels — callers should apply this to a
 * copy right before rendering text or JSON for the end user, never write it
 * back into session/runtime state.
 */
// Dedup only pays for itself when the omitted string is longer than the
// marker that replaces it (JSON: `"inheritsLabel":true` ~21 chars; text:
// `[same label as parent]` ~23). Short duplicated labels (tab bars: "Home",
// "Settings") stay verbatim — cheaper on both surfaces and easier to read.
const MIN_DEDUPED_VALUE_LENGTH = 24;

export function dedupeInheritedSnapshotLabels(nodes: SnapshotNode[]): SnapshotNode[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return nodes;
  const byIndex = buildSnapshotNodeMap(nodes);

  return nodes.map((node) => {
    const ancestorLabel = findNearestAncestorValue(node, byIndex, (candidate) => candidate.label);
    const ancestorIdentifier = findNearestAncestorValue(
      node,
      byIndex,
      (candidate) => candidate.identifier,
    );

    const dedupesLabel =
      typeof node.label === 'string' &&
      node.label.length >= MIN_DEDUPED_VALUE_LENGTH &&
      node.label === ancestorLabel;
    const dedupesIdentifier =
      typeof node.identifier === 'string' &&
      node.identifier.length >= MIN_DEDUPED_VALUE_LENGTH &&
      node.identifier === ancestorIdentifier;

    if (!dedupesLabel && !dedupesIdentifier) return node;

    const next: SnapshotNode = { ...node };
    if (dedupesLabel) {
      delete next.label;
      next.inheritsLabel = true;
    }
    if (dedupesIdentifier) {
      delete next.identifier;
      next.inheritsIdentifier = true;
    }
    return next;
  });
}

function findNearestAncestorValue(
  node: SnapshotNode,
  byIndex: Map<number, SnapshotNode>,
  read: (node: SnapshotNode) => string | undefined,
): string | undefined {
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  while (current) {
    const value = read(current);
    if (typeof value === 'string' && value.length > 0) return value;
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return undefined;
}
