import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { attachSnapshotClickabilityEvidence } from '@agent-device/contracts/capture';
import type { MaestroSelector } from '../../src/internal/program-ir.ts';
import { resolveMaestroTargetFromSnapshot } from '../../src/internal/runtime-targets.ts';
import {
  rankMaestroCandidates,
  selectMaestroPositionMatches,
} from '../../src/internal/runtime-target-ranking.ts';

export type Layer2TreeVector = {
  id: string;
  operation: string;
  selector: MaestroSelector;
  nodes: Array<{
    key: string;
    parentKey: string | null;
    identifier: string;
    label: string | null;
    rect: { x: number; y: number; width: number; height: number } | null;
    clickable?: boolean;
  }>;
  matches: string[];
  selected?: string;
  intermediateRelation?: 'below' | 'above' | 'leftOf' | 'rightOf';
  intermediate?: string[];
  clickableFirstMatches?: string[];
};

export type Layer2TreeResult = {
  upstream: number;
  agent?: number;
  status: 'match' | 'mismatch';
};

/** Compare a sealed upstream vector with the live snapshot resolver. */
export function checkLayer2TreeVector(vector: Layer2TreeVector): Layer2TreeResult {
  const snapshot = snapshotFromTreeVector(vector);
  const ranked = rankMaestroCandidates(snapshot, vector.selector, 'android');
  const actualMatches = ranked.matches.map((node) => vector.nodes[node.index]?.key ?? '');
  const actualOrderedMatches = ranked.ranked.map((node) => vector.nodes[node.index]?.key ?? '');
  const resolution = resolveMaestroTargetFromSnapshot(
    snapshot,
    { selector: vector.selector },
    'android',
  );
  const actualSelected = resolution.ok ? [vector.nodes[resolution.node.index]?.key ?? ''] : [];
  const expectedSelected = vector.selected === undefined ? [] : [vector.selected];
  const actualIntermediate = vector.intermediateRelation
    ? selectMaestroPositionMatches(
        snapshot,
        vector.intermediateRelation,
        vector.selector[vector.intermediateRelation]!,
      ).map((node) => vector.nodes[node.index]?.key ?? '')
    : undefined;
  return {
    upstream: vector.matches.length,
    agent: actualMatches.length,
    status:
      JSON.stringify(actualMatches) === JSON.stringify(vector.matches) &&
      (vector.clickableFirstMatches === undefined ||
        JSON.stringify(actualOrderedMatches) === JSON.stringify(vector.clickableFirstMatches)) &&
      JSON.stringify(actualSelected) === JSON.stringify(expectedSelected) &&
      JSON.stringify(actualIntermediate) === JSON.stringify(vector.intermediate)
        ? 'match'
        : 'mismatch',
  };
}

function snapshotFromTreeVector(vector: Layer2TreeVector): SnapshotState {
  const indexByKey = new Map(vector.nodes.map((node, index) => [node.key, index]));
  const nodes: SnapshotNode[] = vector.nodes.map((node, index) => {
    const parentIndex = node.parentKey === null ? undefined : indexByKey.get(node.parentKey);
    return {
      index,
      ref: `layer2-${node.key}`,
      identifier: node.identifier,
      ...(node.label === null ? {} : { label: node.label }),
      ...(parentIndex === undefined ? {} : { parentIndex }),
      ...(node.rect ? { rect: node.rect } : {}),
    };
  });
  const snapshot = { createdAt: 0, nodes };
  const hasClickabilityEvidence = vector.nodes.some((node) => 'clickable' in node);
  return hasClickabilityEvidence
    ? attachSnapshotClickabilityEvidence(snapshot, {
        kind: 'exact',
        provider: 'android-helper',
        clickableByNodeIndex: new Map(vector.nodes.map((node, index) => [index, node.clickable])),
      })
    : snapshot;
}
