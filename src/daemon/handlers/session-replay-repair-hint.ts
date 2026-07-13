/**
 * ADR 0012 decision 6, R3: the daemon-side `repairHint` computation.
 *
 * Computed daemon-side at divergence time, never by the agent, from (i) the
 * recorded `target-v1` evidence for the diverged action (decision 3's
 * `ancestry`/`scrollRegion`) and (ii) the divergence's own FULL capture —
 * the daemon's own tree, never the flat, 20-capped `screen.refs` wire
 * projection. A target-binding kind's capture is the PRE-action tree;
 * `action-failure` (PR #1223's dispatch-thrown path) captures AFTER the
 * failed response, so its capture is the POST-response tree. The mapping is
 * TOTAL: every (`kind` x evidence-presence x capture-availability) triple
 * resolves to a defined enum, with two fail-safes to `manual` — no recorded
 * evidence, or a sparse/unavailable capture — so `repairHint` is always
 * defined.
 *
 * Lives in the daemon zone (not `src/replay/`, which stays tree-agnostic per
 * `target-identity.ts`'s own contract) because the container-presence test
 * below is a genuine structural containment check over `parentIndex` — the
 * same tree-walking machinery decision 3's own identity-set filter uses
 * (`buildAncestryChain`/`computeScrollRegionKey`, `session-target-evidence.ts`)
 * — not a flat identity-string search.
 */

import type { SnapshotNode } from '../../kernel/snapshot.ts';
import type { ReplayDivergenceKind, ReplayRepairHint } from '../../replay/divergence.ts';
import {
  matchesAncestryPrefix,
  type TargetAnnotationV1,
  type TargetScrollRegion,
} from '../../replay/target-identity.ts';
import {
  buildAncestryChain,
  buildIndexMap,
  computeScrollRegionKey,
  scrollRegionKeysEqual,
} from '../session-target-evidence.ts';

export type ReplayRepairHintCapture =
  | { state: 'available'; nodes: SnapshotNode[] }
  | { state: 'unavailable' };

export function computeReplayRepairHint(params: {
  kind: ReplayDivergenceKind;
  targetEvidence: TargetAnnotationV1 | undefined;
  capture: ReplayRepairHintCapture;
}): ReplayRepairHint {
  const { kind, targetEvidence, capture } = params;
  if (kind === 'identity-mismatch') return 'caution';
  if (kind === 'identity-unverifiable') return 'manual';
  // `kind` is 'selector-miss' or 'action-failure': both route through the
  // container-presence test, differing only in their "container absent" verdict.
  if (!targetEvidence) return 'manual';
  if (capture.state !== 'available') return 'manual';
  // A recording with NO usable structural container signal — empty `ancestry`
  // AND no identified `scrollRegion` — cannot prove it is the same screen, so
  // "present" would degenerate to "the capture is non-empty" and route an
  // unrelated screen to `record-and-heal` (the same mis-binding class as the
  // unidentified-region case). Fail safe to `manual`.
  if (!hasUsableContainerSignal(targetEvidence)) return 'manual';
  const present = isRecordedContainerPresent(targetEvidence, capture.nodes);
  if (kind === 'selector-miss') return present ? 'record-and-heal' : 'state-repair';
  return present ? 'record-and-heal' : 'manual';
}

/**
 * True when the recorded evidence carries at least one trustworthy structural
 * container signal: a non-empty `ancestry` chain, or an IDENTIFIED
 * `scrollRegion` (id/label). Empty ancestry + no/unidentified region is no
 * signal at all.
 */
function hasUsableContainerSignal(recorded: TargetAnnotationV1): boolean {
  if (recorded.ancestry.length > 0) return true;
  return recorded.scrollRegion !== undefined && isIdentifiedScrollRegion(recorded.scrollRegion);
}

/**
 * Genuine ancestor-containment, not a flat identity-string match: "the
 * recorded container still exists" means it still genuinely CONTAINS a
 * descendant carrying the recorded leaf-anchored `ancestry` chain, walked via
 * `parentIndex` the same way decision 3's identity-set filter does — not
 * merely that a node sharing a container's role/label appears somewhere in
 * the capture. A container whose only child was the very element that renamed
 * still counts as present (the renamed sibling is that child); a container
 * reduced to zero matching descendants, or gone entirely, does not.
 *
 * The `scrollRegion` signal is only trusted when it is IDENTIFIED (carries an
 * id or a label). An UNIDENTIFIED region — RN's default `ScrollView`/
 * `FlatList` with no testID — matches "any anonymous scrollview exists,"
 * which is true on nearly every screen and would falsely route an unrelated
 * screen to `record-and-heal` (the exact mis-binding decision 1 retired
 * silent `--update` to prevent). So an identified region must ALSO satisfy
 * the recorded `ancestry` containment (AND); an unidentified or absent region
 * falls back to the `ancestry` test alone.
 */
function isRecordedContainerPresent(recorded: TargetAnnotationV1, nodes: SnapshotNode[]): boolean {
  const byIndex = buildIndexMap(nodes);
  const ancestryPresent = isRecordedAncestryPresent(recorded.ancestry, byIndex, nodes);
  const region = recorded.scrollRegion;
  if (region && isIdentifiedScrollRegion(region)) {
    return ancestryPresent && isScrollRegionPresent(region, byIndex, nodes);
  }
  return ancestryPresent;
}

function isIdentifiedScrollRegion(region: TargetScrollRegion): boolean {
  return region.id !== undefined || region.label !== undefined;
}

function isScrollRegionPresent(
  region: TargetScrollRegion,
  byIndex: Map<number, SnapshotNode>,
  nodes: SnapshotNode[],
): boolean {
  // Some node's OWN nearest scrollable ancestor (walked via parentIndex)
  // resolves to the recorded region: the identified region still contains a
  // descendant.
  return nodes.some((node) => scrollRegionKeysEqual(computeScrollRegionKey(node, byIndex), region));
}

/**
 * Some node's OWN leaf-anchored ancestry chain still matches the recorded
 * target's full `ancestry` prefix — walking the WHOLE recorded chain, not
 * just the immediate parent, so an unrelated screen that happens to reuse the
 * parent role/label (shared app chrome) does not read as containment. Empty
 * ancestry only reaches here alongside an identified `scrollRegion` (the
 * caller fails no-signal cases to `manual` first), so its "capture has
 * content" result is merely AND-neutral against the region test.
 */
function isRecordedAncestryPresent(
  ancestry: TargetAnnotationV1['ancestry'],
  byIndex: Map<number, SnapshotNode>,
  nodes: SnapshotNode[],
): boolean {
  if (ancestry.length === 0) return nodes.length > 0;
  return nodes.some((node) => {
    const observed = buildAncestryChain(node, byIndex, ancestry.length);
    return !observed.broken && matchesAncestryPrefix(observed.chain, ancestry);
  });
}
