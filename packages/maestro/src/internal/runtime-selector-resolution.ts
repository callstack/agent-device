import { buildSnapshotNodeMap } from '@agent-device/contracts/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import type { MaestroSelector } from './program-ir.ts';
import { hasMaestroLeafSelectorFields } from './selector-relations.ts';
import {
  selectMaestroPositionMatches,
  type MaestroPositionRelation,
} from './runtime-target-position.ts';
import { matchesMaestroTypedSelector } from './runtime-target-policy.ts';

export type MaestroSelectorResolution = {
  /** Relation-composed matches in snapshot order, before this selector's own index. */
  readonly matches: SnapshotNode[];
  /** Matches after applying this selector's own y/x-ordered index. */
  readonly indexed: SnapshotNode[];
};

export type MaestroResolutionProbe = {
  onNodeMapBuilt?: () => void;
  onSelectorComputed?: (selector: MaestroSelector) => void;
  onPositionComputed?: (relation: MaestroPositionRelation, anchor: MaestroSelector) => void;
};

export type MaestroSnapshotResolver = {
  readonly nodeByIndex: ReadonlyMap<number, SnapshotNode>;
  resolve(selector: MaestroSelector): MaestroSelectorResolution;
  resolvePosition(relation: MaestroPositionRelation, anchor: MaestroSelector): SnapshotNode[];
};

type MaestroPositionResolution = {
  ordered: SnapshotNode[];
  candidateIndexes: ReadonlySet<number>;
};

/** Resolve a recursive selector graph once for one immutable snapshot. */
export function createMaestroSnapshotResolver(
  snapshot: SnapshotState,
  probe: MaestroResolutionProbe = {},
): MaestroSnapshotResolver {
  const nodeByIndex = buildSnapshotNodeMap(snapshot.nodes);
  probe.onNodeMapBuilt?.();
  const selectorCache = new WeakMap<MaestroSelector, MaestroSelectorResolution>();
  const resolving = new WeakSet<MaestroSelector>();
  const ancestorIndexesByNode = new WeakMap<SnapshotNode, ReadonlySet<number>>();
  const positionCaches = new Map<
    MaestroPositionRelation,
    WeakMap<MaestroSelector, MaestroPositionResolution>
  >();

  const parentOf = (node: SnapshotNode): SnapshotNode | undefined =>
    node.parentIndex === undefined
      ? undefined
      : (nodeByIndex.get(node.parentIndex) ?? snapshot.nodes[node.parentIndex]);
  const ancestorIndexes = (node: SnapshotNode): ReadonlySet<number> => {
    const cached = ancestorIndexesByNode.get(node);
    if (cached) return cached;
    const indexes = new Set<number>();
    const visited = new Set<number>();
    let parent = parentOf(node);
    while (parent && !visited.has(parent.index)) {
      visited.add(parent.index);
      indexes.add(parent.index);
      parent = parentOf(parent);
    }
    ancestorIndexesByNode.set(node, indexes);
    return indexes;
  };

  const resolvePositionEntry = (
    relation: MaestroPositionRelation,
    anchor: MaestroSelector,
  ): MaestroPositionResolution => {
    let cache = positionCaches.get(relation);
    if (!cache) {
      cache = new WeakMap();
      positionCaches.set(relation, cache);
    }
    const cached = cache.get(anchor);
    if (cached) return cached;
    probe.onPositionComputed?.(relation, anchor);
    const ordered = selectMaestroPositionMatches(snapshot.nodes, relation, resolve(anchor).indexed);
    const resolution = {
      ordered,
      candidateIndexes: new Set(ordered.map((node) => node.index)),
    };
    cache.set(anchor, resolution);
    return resolution;
  };

  const resolvePosition = (
    relation: MaestroPositionRelation,
    anchor: MaestroSelector,
  ): SnapshotNode[] => resolvePositionEntry(relation, anchor).ordered;

  const resolvePositionIndexes = (
    relation: MaestroPositionRelation,
    anchor: MaestroSelector,
  ): ReadonlySet<number> => resolvePositionEntry(relation, anchor).candidateIndexes;

  const resolve = (selector: MaestroSelector): MaestroSelectorResolution => {
    const cached = selectorCache.get(selector);
    if (cached) return cached;
    if (resolving.has(selector)) {
      throw new AppError('INVALID_ARGS', 'Maestro selector relations cannot contain cycles.');
    }
    resolving.add(selector);
    probe.onSelectorComputed?.(selector);
    try {
      const matches = resolveWithoutOwnIndex(
        snapshot,
        selector,
        parentOf,
        ancestorIndexes,
        resolve,
        resolvePositionIndexes,
      );
      const resolution = {
        matches,
        indexed: selectMaestroIndexedMatches(matches, selector.index),
      };
      selectorCache.set(selector, resolution);
      return resolution;
    } finally {
      resolving.delete(selector);
    }
  };

  return { nodeByIndex, resolve, resolvePosition };
}

type ResolveSelector = (selector: MaestroSelector) => MaestroSelectorResolution;
type ResolvePositionIndexes = (
  relation: MaestroPositionRelation,
  anchor: MaestroSelector,
) => ReadonlySet<number>;

function resolveWithoutOwnIndex(
  snapshot: SnapshotState,
  selector: MaestroSelector,
  parentOf: (node: SnapshotNode) => SnapshotNode | undefined,
  ancestorIndexes: (node: SnapshotNode) => ReadonlySet<number>,
  resolve: ResolveSelector,
  resolvePositionIndexes: ResolvePositionIndexes,
): SnapshotNode[] {
  const {
    index: _index,
    childOf,
    below: _below,
    above: _above,
    leftOf: _leftOf,
    rightOf: _rightOf,
    containsChild,
    containsDescendants,
    ...leaf
  } = selector;
  let matches = hasMaestroLeafSelectorFields(leaf)
    ? snapshot.nodes.filter((node) => matchesMaestroTypedSelector(node, leaf))
    : [...snapshot.nodes];

  if (childOf) {
    const parentIndexes = new Set(resolve(childOf).indexed.map((node) => node.index));
    matches = matches.filter((node) => setsIntersect(ancestorIndexes(node), parentIndexes));
  }
  if (containsChild) {
    const matchedParentIndexes = new Set(
      resolve(containsChild)
        .indexed.map(parentOf)
        .filter((node): node is SnapshotNode => node !== undefined)
        .map((node) => node.index),
    );
    matches = matches.filter((node) => matchedParentIndexes.has(node.index));
  }
  if (containsDescendants) {
    const containingAncestorSets = containsDescendants.map((nested) =>
      collectContainingAncestorIndexes(resolve(nested).indexed, ancestorIndexes),
    );
    matches = matches.filter((node) =>
      containingAncestorSets.every((indexes) => indexes.has(node.index)),
    );
  }
  for (const [relation, anchor] of positionalSelectors(selector)) {
    const relatedIndexes = resolvePositionIndexes(relation, anchor);
    matches = matches.filter((node) => relatedIndexes.has(node.index));
  }
  return matches;
}

function collectContainingAncestorIndexes(
  nodes: readonly SnapshotNode[],
  ancestorIndexes: (node: SnapshotNode) => ReadonlySet<number>,
): Set<number> {
  const containingIndexes = new Set<number>();
  for (const node of nodes) {
    for (const index of ancestorIndexes(node)) containingIndexes.add(index);
  }
  return containingIndexes;
}

function setsIntersect(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function positionalSelectors(
  selector: MaestroSelector,
): Array<[MaestroPositionRelation, MaestroSelector]> {
  return [
    ['below', selector.below],
    ['above', selector.above],
    ['leftOf', selector.leftOf],
    ['rightOf', selector.rightOf],
  ].filter((entry): entry is [MaestroPositionRelation, MaestroSelector] => entry[1] !== undefined);
}

function selectMaestroIndexedMatches(
  matches: readonly SnapshotNode[],
  index: number | string | undefined,
): SnapshotNode[] {
  if (index === undefined) return [...matches];
  const selected = sortMaestroMatchesForIndex(matches)[resolveMaestroSelectorIndex(index)];
  return selected ? [selected] : [];
}

export function selectMaestroIndexedNode(
  matches: readonly SnapshotNode[],
  index: number | string | undefined,
): SnapshotNode | undefined {
  return index === undefined
    ? matches[0]
    : sortMaestroMatchesForIndex(matches)[resolveMaestroSelectorIndex(index)];
}

function sortMaestroMatchesForIndex(matches: readonly SnapshotNode[]): SnapshotNode[] {
  return [...matches].sort((left, right) => {
    const leftY = finiteCoordinate(left.rect?.y);
    const rightY = finiteCoordinate(right.rect?.y);
    if (leftY !== rightY) return leftY - rightY;
    return finiteCoordinate(left.rect?.x) - finiteCoordinate(right.rect?.x);
  });
}

function finiteCoordinate(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function resolveMaestroSelectorIndex(value: number | string): number {
  const index = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new AppError('INVALID_ARGS', 'Maestro selector.index must be a non-negative integer.');
  }
  return index;
}
