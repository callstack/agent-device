import { readSnapshotClickabilityEvidence } from '@agent-device/contracts/capture';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';

type MaestroClickabilityPlatform = 'android' | 'ios';

type MaestroClickabilityProviderDeclaration =
  | { kind: 'exact'; provider: 'android-helper' }
  | {
      kind: 'divergence';
      provider: 'apple-xctest';
      reason: 'maestro-clickable-not-exposed-by-provider';
    };

/** The admitted Maestro providers and the evidence contract each one owns. */
const MAESTRO_CLICKABILITY_PROVIDER_REGISTRY = {
  android: { kind: 'exact', provider: 'android-helper' },
  ios: {
    kind: 'divergence',
    provider: 'apple-xctest',
    reason: 'maestro-clickable-not-exposed-by-provider',
  },
} as const satisfies Record<MaestroClickabilityPlatform, MaestroClickabilityProviderDeclaration>;

export type MaestroClickabilityDecision =
  | {
      kind: 'exact';
      provider: 'android-helper';
      clickableByNodeIndex: ReadonlyMap<number, boolean | undefined>;
    }
  | {
      kind: 'divergence';
      provider: 'android-helper' | 'apple-xctest';
      reason:
        | 'exact-evidence-not-retained'
        | 'maestro-clickable-not-exposed-by-provider'
        | 'unregistered-provider-evidence';
    };

/** Resolve provider evidence once per selector operation; missing exact evidence is explicit. */
export function resolveMaestroClickability(
  snapshot: SnapshotState,
  platform: MaestroClickabilityPlatform,
): MaestroClickabilityDecision {
  const declaration = MAESTRO_CLICKABILITY_PROVIDER_REGISTRY[platform];
  if (declaration.kind === 'divergence') return declaration;

  const evidence = readSnapshotClickabilityEvidence(snapshot);
  if (!evidence) {
    return {
      kind: 'divergence',
      provider: declaration.provider,
      reason: 'exact-evidence-not-retained',
    };
  }
  if (evidence.kind !== 'exact' || evidence.provider !== declaration.provider) {
    return {
      kind: 'divergence',
      provider: declaration.provider,
      reason: 'unregistered-provider-evidence',
    };
  }
  return evidence;
}

/** Apply pinned `Filters.clickableFirst()` ordering, preserving stable equal groups. */
export function orderMaestroClickableFirst(
  matches: readonly SnapshotNode[],
  decision: MaestroClickabilityDecision,
): SnapshotNode[] {
  if (decision.kind !== 'exact') return [...matches];
  return matches
    .map((node, order) => ({
      node,
      order,
      rank: clickableRank(decision.clickableByNodeIndex.get(node.index)),
    }))
    .sort((left, right) => right.rank - left.rank || left.order - right.order)
    .map(({ node }) => node);
}

function clickableRank(value: boolean | undefined): number {
  return value === true ? 2 : value === false ? 1 : 0;
}
