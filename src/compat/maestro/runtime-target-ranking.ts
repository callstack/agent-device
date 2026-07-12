import type { TouchReferenceFrame } from '../../daemon/touch-reference-frame.ts';
import type { Rect, SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import { buildSnapshotNodeByIndex } from '../../snapshot/snapshot-processing.ts';
import {
  promoteMaestroSnapshotMatch,
  preferOnScreenMatches,
  resolveMaestroNodeRect,
  type SnapshotNodeByIndex,
} from './runtime-target-ranking-geometry.ts';
import { selectPreferredMaestroSnapshotMatch } from './runtime-target-ranking-duplicates.ts';
import { inferMaestroMissingTabSlotMatch } from './runtime-target-ranking-tabs.ts';
import type {
  MaestroPreferredContext,
  MaestroResolvedSnapshotMatch,
} from './runtime-target-policy.ts';

export function selectMaestroSnapshotMatch(
  nodes: SnapshotState['nodes'],
  matches: SnapshotNode[],
  index: number | undefined,
  visibleTextQuery: string | null,
  frame: TouchReferenceFrame | undefined,
  requireOnScreen = false,
  promoteTapTarget = false,
  preferredContext?: MaestroPreferredContext,
): { node: SnapshotNode; rect: Rect } | null {
  const nodeByIndex = buildSnapshotNodeByIndex(nodes);
  const candidates = resolveMaestroSnapshotMatchCandidates(
    nodes,
    matches,
    nodeByIndex,
    visibleTextQuery,
    index,
    frame,
    requireOnScreen,
  );
  const target = chooseMaestroSnapshotMatch(
    nodes,
    candidates,
    index,
    visibleTextQuery,
    promoteTapTarget,
    preferredContext,
  );
  return promoteMaestroSnapshotMatch(nodes, target, nodeByIndex, promoteTapTarget, frame);
}

function resolveMaestroSnapshotMatchCandidates(
  nodes: SnapshotState['nodes'],
  matches: SnapshotNode[],
  nodeByIndex: SnapshotNodeByIndex,
  visibleTextQuery: string | null,
  index: number | undefined,
  frame: TouchReferenceFrame | undefined,
  requireOnScreen: boolean,
): MaestroResolvedSnapshotMatch[] {
  const resolved = matches
    .map((node) => resolveMaestroSnapshotMatch(nodes, node, nodeByIndex))
    .filter((candidate): candidate is MaestroResolvedSnapshotMatch => Boolean(candidate));
  const concrete = resolved.filter((candidate) => !candidate.inheritedRect);
  const candidates = concrete.length > 0 ? concrete : resolved;
  if (!visibleTextQuery || index !== undefined) return resolved;
  return preferOnScreenMatches(candidates, frame, requireOnScreen);
}

function resolveMaestroSnapshotMatch(
  nodes: SnapshotState['nodes'],
  node: SnapshotNode,
  nodeByIndex: SnapshotNodeByIndex,
): MaestroResolvedSnapshotMatch | null {
  const match = resolveMaestroNodeRect(nodes, node, nodeByIndex);
  return match ? { node, rect: match.rect, inheritedRect: match.inherited } : null;
}

function chooseMaestroSnapshotMatch(
  nodes: SnapshotState['nodes'],
  candidates: MaestroResolvedSnapshotMatch[],
  index: number | undefined,
  visibleTextQuery: string | null,
  promoteTapTarget: boolean,
  preferredContext?: MaestroPreferredContext,
): MaestroResolvedSnapshotMatch | null {
  if (index !== undefined) return candidates[index] ?? null;
  const best = selectPreferredMaestroSnapshotMatch(
    nodes,
    candidates,
    visibleTextQuery,
    promoteTapTarget,
    preferredContext,
  );
  if (!shouldInferMaestroTabSlot(best, visibleTextQuery, promoteTapTarget)) return best;
  return inferMaestroMissingTabSlotMatch(nodes, best, visibleTextQuery!) ?? best;
}

function shouldInferMaestroTabSlot(
  match: MaestroResolvedSnapshotMatch | null,
  visibleTextQuery: string | null,
  promoteTapTarget: boolean,
): match is MaestroResolvedSnapshotMatch {
  return Boolean(promoteTapTarget && visibleTextQuery && match);
}
