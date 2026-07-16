import type { Platform, PublicPlatform } from '../kernel/device.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { isNodeVisible } from './node.ts';
import { extractNodeText, normalizeType } from '../snapshot/snapshot-processing.ts';
import { idMatchCountInTree, readNodeLocalIdentity } from '../replay/target-identity-node.ts';

export function buildSelectorChainForNode(
  node: SnapshotNode,
  _platform: Platform | PublicPlatform,
  options: { action?: 'click' | 'fill' | 'get'; nodes?: readonly SnapshotNode[] } = {},
): string[] {
  const chain: string[] = [];
  const role = normalizeType(node.type ?? '');
  const id = selectableId(node, options.nodes);
  const label = normalizeSelectorText(node.label);
  const value = normalizeSelectorText(node.value);
  const text = normalizeSelectorText(extractNodeText(node));
  const requireEditable = options.action === 'fill';

  if (id) {
    chain.push(`id=${quoteSelectorValue(id)}`);
  }
  if (role && label) {
    chain.push(
      requireEditable
        ? `role=${quoteSelectorValue(role)} label=${quoteSelectorValue(label)} editable=true`
        : `role=${quoteSelectorValue(role)} label=${quoteSelectorValue(label)}`,
    );
  }
  if (label) {
    chain.push(
      requireEditable
        ? `label=${quoteSelectorValue(label)} editable=true`
        : `label=${quoteSelectorValue(label)}`,
    );
  }
  if (value) {
    chain.push(
      requireEditable
        ? `value=${quoteSelectorValue(value)} editable=true`
        : `value=${quoteSelectorValue(value)}`,
    );
  }
  if (text && text !== label && text !== value) {
    chain.push(
      requireEditable
        ? `text=${quoteSelectorValue(text)} editable=true`
        : `text=${quoteSelectorValue(text)}`,
    );
  }
  if (role && requireEditable && !chain.some((entry) => entry.includes('editable=true'))) {
    chain.push(`role=${quoteSelectorValue(role)} editable=true`);
  }

  const deduped = uniqueStrings(chain);
  if (deduped.length === 0 && role) {
    deduped.push(
      requireEditable
        ? `role=${quoteSelectorValue(role)} editable=true`
        : `role=${quoteSelectorValue(role)}`,
    );
  }
  if (deduped.length === 0) {
    const visible = isNodeVisible(node);
    if (visible) deduped.push('visible=true');
  }
  return deduped;
}

/**
 * ADR 0012 decision 3 amendment (#1269): an id may lead the selector chain
 * only when it uniquely denotes the node in the record-time tree it was
 * captured from — a shared framework resource id (Android's
 * `android:id/title` matching every list row is the measured case) resolves
 * the wrong element under positional drift on replay. The rule is
 * capture-time uniqueness, not an id-namespace heuristic: a reused RN
 * `FlatList` `testID` hits the same demotion.
 *
 * The uniqueness DECISION goes through `idMatchCountInTree` — the SAME
 * predicate `computeTargetEvidence` uses for the `target-v1` identity tuple,
 * over the canonical identity id (`readNodeLocalIdentity`: NFC + 256-byte
 * cap) — so the chain and the tuple demote in lockstep and never disagree.
 * Only the decision is shared; the kept clause still emits the chain's own
 * `normalizeSelectorText` id (an id that survives the check keeps its
 * existing string form — no behavior change for the already-unique path).
 * `nodes` is the record-time tree; every writer call site passes it. When
 * absent (a node built in isolation, e.g. a test with no tree) the id is
 * trusted as-is.
 */
function selectableId(
  node: SnapshotNode,
  nodes: readonly SnapshotNode[] | undefined,
): string | null {
  const id = normalizeSelectorText(node.identifier);
  if (!id || !nodes) return id;
  // A non-null `normalizeSelectorText` id guarantees a defined canonical id
  // (NFC/cap never empty a non-whitespace string), so this is always the
  // identity id the tuple would carry.
  const canonicalId = readNodeLocalIdentity(node).id;
  if (canonicalId === undefined) return id;
  return idMatchCountInTree(nodes, canonicalId) > 1 ? null : id;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function quoteSelectorValue(value: string): string {
  return JSON.stringify(value);
}

/** Trim, then treat an all-whitespace/empty string as absent. Shared with #1280's press-retarget identity-empty check so it matches this chain builder's value/text normalization exactly. */
export function normalizeSelectorText(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}
