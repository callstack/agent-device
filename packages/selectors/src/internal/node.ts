import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import { formatRole, type SnapshotNode } from '@agent-device/kernel/snapshot';
import { isFillableType, normalizeType } from '@agent-device/contracts/snapshot';

export function isNodeVisible(node: SnapshotNode): boolean {
  if (node.hittable === true) return true;
  if (!node.rect) return false;
  return node.rect.width > 0 && node.rect.height > 0;
}

export function isNodeEditable(node: SnapshotNode, platform: Platform | PublicPlatform): boolean {
  return isFillableType(node.type ?? '', platform) && node.enabled !== false;
}

/**
 * Every `role=` spelling this node accepts, in ONE place (#3021): the
 * canonical `kind` vocabulary first, then — during the deprecation window —
 * the node's retired role spelling. The `role=` selector term and the
 * `find role=` locator both read this and nothing else, which is what keeps
 * the two, and `kind` itself, unable to disagree.
 *
 * The canonical spelling prefers the `kind` the capture published through
 * `attachRefs` and falls back to the same `formatRole` that publishes it, so
 * there is no second normalization of `kind` in this package. The window
 * spells the retired meaning through `@agent-device/contracts` `normalizeType`
 * — the live owner of that spelling, and the SAME function
 * `buildSelectorChainForNode` uses to RECORD `role=` chains — so the window
 * cannot drift from what recorded scripts carry; if `normalizeType` moves,
 * both sides move together. It is node-scoped, never a kind→leaves table:
 * `role=linearlayout` must not start matching a `FrameLayout` row just
 * because the coarse `group` kind renamed both leaves.
 *
 * Closing the window means deleting the second entry, and only once
 * `buildSelectorChainForNode` stops recording leaf spellings into chains —
 * freshly recorded scripts replay against the window.
 */
export function roleSpellingsOfNode(node: SnapshotNode): readonly string[] {
  const kind = node.kind ?? formatRole(node.type ?? 'Element');
  const retired = normalizeType(node.type ?? '');
  return retired && retired !== kind ? [kind, retired] : [kind];
}
