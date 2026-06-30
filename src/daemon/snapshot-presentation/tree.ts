import type { RawSnapshotNode } from '../../kernel/snapshot.ts';
import { normalizeType } from '../../snapshot/snapshot-processing.ts';
export { areRectsApproximatelyEqual } from '../../utils/rect-center.ts';

export type SnapshotTreeRuleContext = {
  replacements: Map<number, RawSnapshotNode>;
  suppressedIndexes: Set<number>;
};

const descendantEndPositionCache = new WeakMap<RawSnapshotNode[], number[]>();

export function collectDescendants(
  nodes: RawSnapshotNode[],
  startPosition: number,
): RawSnapshotNode[] {
  const node = nodes[startPosition];
  if (!node) return [];
  const endPosition = getDescendantEndPositions(nodes)[startPosition] ?? startPosition + 1;
  return nodes.slice(startPosition + 1, endPosition);
}

export function findDescendant(
  nodes: RawSnapshotNode[],
  startPosition: number,
  predicate: (node: RawSnapshotNode) => boolean,
): RawSnapshotNode | undefined {
  const endPosition = getDescendantEndPositions(nodes)[startPosition] ?? startPosition + 1;
  for (let position = startPosition + 1; position < endPosition; position += 1) {
    const node = nodes[position];
    if (node && predicate(node)) {
      return node;
    }
  }
  return undefined;
}

export function forEachDescendant(
  nodes: RawSnapshotNode[],
  startPosition: number,
  visitor: (node: RawSnapshotNode) => void,
): void {
  const endPosition = getDescendantEndPositions(nodes)[startPosition] ?? startPosition + 1;
  for (let position = startPosition + 1; position < endPosition; position += 1) {
    const node = nodes[position];
    if (node) {
      visitor(node);
    }
  }
}

function getDescendantEndPositions(nodes: RawSnapshotNode[]): number[] {
  const cached = descendantEndPositionCache.get(nodes);
  if (cached) {
    return cached;
  }

  const endPositions = new Array<number>(nodes.length);
  const stack: Array<{ depth: number; position: number }> = [];
  for (const [position, node] of nodes.entries()) {
    const depth = node?.depth ?? 0;
    while (stack.length > 0 && depth <= stack[stack.length - 1]!.depth) {
      const previous = stack.pop()!;
      endPositions[previous.position] = position;
    }
    stack.push({ depth, position });
  }
  for (const entry of stack) {
    endPositions[entry.position] = nodes.length;
  }
  descendantEndPositionCache.set(nodes, endPositions);
  return endPositions;
}

function collectAncestors(
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
): RawSnapshotNode[] {
  const ancestors: RawSnapshotNode[] = [];
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  const visited = new Set<number>();
  while (current && !visited.has(current.index)) {
    visited.add(current.index);
    ancestors.push(current);
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return ancestors;
}

export function findNearestAncestor(
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
  predicate: (ancestor: RawSnapshotNode) => boolean,
): RawSnapshotNode | null {
  for (const ancestor of collectAncestors(node, byIndex)) {
    if (predicate(ancestor)) {
      return ancestor;
    }
  }
  return null;
}

export function findNearestScrollableContainer(
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
  options: { includeSelf?: boolean } = {},
): RawSnapshotNode | null {
  const self = options.includeSelf === true && isScrollableSnapshotType(node.type) ? node : null;
  return (
    self ??
    findNearestAncestor(node, byIndex, (ancestor) => isScrollableSnapshotType(ancestor.type))
  );
}

export function shouldSuppressRepeatedTextDescendant(
  node: RawSnapshotNode,
  parentLabel: string,
): boolean {
  const type = normalizeType(node.type ?? '');
  const label = node.label?.trim();
  if (isDisabledChevronButton(node)) {
    return true;
  }
  if (type === 'other' && !label && !node.value) {
    return true;
  }
  if ((type === 'other' || type === 'statictext') && label && parentLabel.includes(label)) {
    return true;
  }
  if (type === 'image') {
    return true;
  }
  return false;
}

export function isSemanticActionNode(node: RawSnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  return (
    type === 'button' ||
    type === 'link' ||
    type === 'switch' ||
    type === 'searchfield' ||
    type === 'textfield'
  );
}

export function isDisabledChevronButton(node: RawSnapshotNode): boolean {
  return (
    normalizeType(node.type ?? '') === 'button' &&
    node.label?.trim() === 'chevron' &&
    node.enabled === false
  );
}

export function isScrollableSnapshotType(type: string | undefined): boolean {
  const normalized = normalizeType(type ?? '');
  return (
    normalized === 'collectionview' ||
    normalized === 'table' ||
    normalized === 'scrollview' ||
    normalized === 'scrollarea'
  );
}

export function isRepeatedStaticNode(node: RawSnapshotNode, parentLabel: string): boolean {
  const label = node.label?.trim();
  if (!label || label !== parentLabel) {
    return false;
  }
  const type = normalizeType(node.type ?? '');
  return type === 'other' || type === 'statictext' || type === 'link';
}

export function mergeReplacement(
  replacements: Map<number, RawSnapshotNode>,
  node: RawSnapshotNode,
  patch: Partial<RawSnapshotNode>,
): void {
  replacements.set(node.index, {
    ...node,
    ...replacements.get(node.index),
    ...patch,
  });
}

export function findLargestViewportRect(nodes: Iterable<RawSnapshotNode>): RawSnapshotNode['rect'] {
  let viewport: RawSnapshotNode['rect'];
  for (const node of nodes) {
    const type = normalizeType(node.type ?? '');
    if ((type === 'application' || type === 'window') && isLargerRect(node.rect, viewport)) {
      viewport = node.rect;
    }
  }
  return viewport;
}

export function isMostlyViewportSizedRect(
  rect: RawSnapshotNode['rect'],
  viewport: RawSnapshotNode['rect'],
  minRatio = 0.8,
): boolean {
  const rectArea = getRectArea(rect);
  const viewportArea = getRectArea(viewport);
  return rectArea > 0 && viewportArea > 0 && rectArea / viewportArea >= minRatio;
}

function isLargerRect(
  candidate: RawSnapshotNode['rect'],
  current: RawSnapshotNode['rect'],
): candidate is NonNullable<RawSnapshotNode['rect']> {
  return Boolean(candidate && (!current || getRectArea(candidate) > getRectArea(current)));
}

function getRectArea(rect: RawSnapshotNode['rect']): number {
  return rect ? rect.width * rect.height : 0;
}

export function reindexSnapshotNodesWithSuppressedParents(
  nodes: RawSnapshotNode[],
  suppressedIndexes: Set<number>,
  originalNodes: RawSnapshotNode[],
): RawSnapshotNode[] {
  const originalByIndex = new Map(originalNodes.map((node) => [node.index, node]));
  const indexMap = new Map<number, number>();
  for (const [index, node] of nodes.entries()) {
    indexMap.set(node.index, index);
  }
  return nodes.map((node, index) => {
    let parentIndex =
      typeof node.parentIndex === 'number' ? indexMap.get(node.parentIndex) : undefined;
    if (parentIndex === undefined && typeof node.parentIndex === 'number') {
      parentIndex = findNearestKeptAncestorIndex(
        node.parentIndex,
        suppressedIndexes,
        originalByIndex,
        indexMap,
      );
    }
    return {
      ...node,
      index,
      parentIndex,
    };
  });
}

function findNearestKeptAncestorIndex(
  parentIndex: number,
  suppressedIndexes: Set<number>,
  originalByIndex: Map<number, RawSnapshotNode>,
  indexMap: Map<number, number>,
): number | undefined {
  let currentIndex: number | undefined = parentIndex;
  const visited = new Set<number>();
  while (typeof currentIndex === 'number' && !visited.has(currentIndex)) {
    visited.add(currentIndex);
    if (!suppressedIndexes.has(currentIndex)) {
      return indexMap.get(currentIndex);
    }
    currentIndex = originalByIndex.get(currentIndex)?.parentIndex;
  }
  return undefined;
}
