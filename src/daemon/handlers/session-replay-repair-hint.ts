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
import { matchesAncestryPrefix, type TargetAnnotationV1 } from '../../replay/target-identity.ts';
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
  const present = isRecordedContainerPresent(targetEvidence, capture.nodes);
  if (kind === 'selector-miss') return present ? 'record-and-heal' : 'state-repair';
  return present ? 'record-and-heal' : 'manual';
}

/**
 * Genuine ancestor-containment, not a flat identity-string match: "the
 * recorded container still exists" means it still genuinely CONTAINS a
 * child in the current tree, walked via `parentIndex` the same way decision
 * 3's identity-set filter does — not merely that a node sharing its
 * role/label happens to appear somewhere in the capture. A container whose
 * only child was the very element that renamed still counts as present (the
 * renamed sibling is that child); a container reduced to zero children, or
 * gone entirely, does not.
 *
 * When the recording carries neither a scroll region nor any ancestor (a
 * root-level target), there is no structural relationship left to test, so
 * presence falls back to "the capture has any content at all."
 */
function isRecordedContainerPresent(recorded: TargetAnnotationV1, nodes: SnapshotNode[]): boolean {
  const byIndex = buildIndexMap(nodes);
  if (recorded.scrollRegion) {
    const region = recorded.scrollRegion;
    // Some node's OWN nearest scrollable ancestor (walked via parentIndex)
    // resolves to the recorded region: the region still contains something.
    return nodes.some((node) =>
      scrollRegionKeysEqual(computeScrollRegionKey(node, byIndex), region),
    );
  }
  const container = recorded.ancestry[0];
  if (!container) return nodes.length > 0;
  // Some node's OWN immediate parent (a 1-entry ancestry walk) matches the
  // recorded container: the container still has at least one child.
  return nodes.some((node) => {
    const observed = buildAncestryChain(node, byIndex, 1);
    return !observed.broken && matchesAncestryPrefix(observed.chain, [container]);
  });
}
