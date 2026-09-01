import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import type { IosSnapshotFoldPolicy, IosSnapshotPresentationNode } from './types.ts';

const REGULAR_ELIGIBLE_TYPES = new Set([
  'button',
  'cell',
  'checkbox',
  'collectionview',
  'link',
  'menuitem',
  'picker',
  'searchfield',
  'securetextfield',
  'segmentedcontrol',
  'slider',
  'scrollview',
  'stepper',
  'switch',
  'tabbar',
  'table',
  'textfield',
  'textview',
  'webview',
]);

type ProjectionInput = Readonly<{
  nodes: readonly IosSnapshotPresentationNode[];
  projection: 'regular' | 'raw';
  scope: string | null;
  depth: number | null;
  foldPolicy: IosSnapshotFoldPolicy;
}>;

export type IosSnapshotProjectionResult = Readonly<{
  nodes: RawSnapshotNode[];
  sourceIndexes: readonly number[];
}>;

export function projectIosSnapshot(input: ProjectionInput): IosSnapshotProjectionResult {
  const depths = resolveRawDepths(input.nodes);
  const scoped = scopeIosSnapshotNodes(input, depths);
  return input.projection === 'raw'
    ? projectRawNodes(scoped, input.depth, depths)
    : projectRegularNodes(scoped, input.depth);
}

export function projectIosQualitySnapshot(
  input: Omit<ProjectionInput, 'scope'>,
): IosSnapshotProjectionResult {
  const depths = resolveRawDepths(input.nodes);
  return input.projection === 'raw'
    ? projectRawNodes(input.nodes, input.depth, depths)
    : projectRegularNodes(input.nodes, input.depth);
}

function isEligibleForIosRegularPresentation(node: RawSnapshotNode): boolean {
  if (node.parentIndex === undefined) return true;
  return REGULAR_ELIGIBLE_TYPES.has(normalizeType(node.type ?? '')) || hasSemanticContent(node);
}

function scopeIosSnapshotNodes(
  input: ProjectionInput,
  depths: ReadonlyMap<number, number>,
): IosSnapshotPresentationNode[] {
  const query = input.scope?.trim().toLowerCase();
  if (!query) return [...input.nodes];

  for (let start = 0; start < input.nodes.length; start += 1) {
    const candidate = input.nodes[start];
    if (!candidate || !matchesScope(candidate.raw, query)) continue;
    const range = subtreeRange(input.nodes, start, depths);
    const contributes =
      input.projection === 'raw' ||
      range.some((position) => isEligibleForIosRegularPresentation(input.nodes[position]!.raw));
    if (!contributes) continue;

    const scoped = range.map((position) => input.nodes[position]!);
    const limited =
      input.projection === 'raw' && input.depth !== null
        ? scoped.filter(
            (node) => rawDepth(node, depths) - rawDepth(candidate, depths) <= input.depth!,
          )
        : scoped;
    return reindexScopedNodes(limited, rawDepth(candidate, depths), depths);
  }
  return [];
}

function projectRawNodes(
  nodes: readonly IosSnapshotPresentationNode[],
  maximumDepth: number | null,
  depths: ReadonlyMap<number, number>,
): IosSnapshotProjectionResult {
  const selected =
    maximumDepth === null
      ? [...nodes]
      : nodes.filter((node) => rawDepth(node, depths) <= maximumDepth);
  return {
    nodes: selected.map((node) => ({ ...node.raw, rect: node.raw.rect })),
    sourceIndexes: selected.map((node) => node.sourceIndex),
  };
}

function projectRegularNodes(
  sourceNodes: readonly IosSnapshotPresentationNode[],
  maximumDepth: number | null,
): IosSnapshotProjectionResult {
  const presented: RawSnapshotNode[] = [];
  const sourceIndexes: number[] = [];
  const nearestPresented = new Map<number, RawSnapshotNode>();

  for (const node of sourceNodes) {
    const parent = readNearestPresentedParent(node, nearestPresented);
    const projected = createRegularProjectedNode(node, parent, maximumDepth, presented.length);
    if (!projected) {
      rememberNearestPresented(node, parent, nearestPresented);
      continue;
    }
    presented.push(projected);
    sourceIndexes.push(node.sourceIndex);
    nearestPresented.set(node.raw.index, projected);
  }
  return { nodes: presented, sourceIndexes };
}

function readNearestPresentedParent(
  node: IosSnapshotPresentationNode,
  nearestPresented: ReadonlyMap<number, RawSnapshotNode>,
): RawSnapshotNode | undefined {
  return node.raw.parentIndex === undefined
    ? undefined
    : nearestPresented.get(node.raw.parentIndex);
}

function createRegularProjectedNode(
  node: IosSnapshotPresentationNode,
  parent: RawSnapshotNode | undefined,
  maximumDepth: number | null,
  index: number,
): RawSnapshotNode | undefined {
  if (!isEligibleForIosRegularPresentation(node.raw)) return undefined;
  const depth = parent ? (parent.depth ?? 0) + 1 : 0;
  if (maximumDepth !== null && depth > maximumDepth) return undefined;
  return {
    ...node.raw,
    index,
    depth,
    parentIndex: parent?.index,
    ...(node.effectiveRect ? { rect: node.effectiveRect } : { rect: undefined }),
    hittable: isProjectedNodeHittable(node),
  };
}

function isProjectedNodeHittable(node: IosSnapshotPresentationNode): boolean {
  return Boolean(
    node.raw.hittable === true &&
    node.effectiveRect &&
    node.effectiveRect.width > 0 &&
    node.effectiveRect.height > 0,
  );
}

function rememberNearestPresented(
  node: IosSnapshotPresentationNode,
  parent: RawSnapshotNode | undefined,
  nearestPresented: Map<number, RawSnapshotNode>,
): void {
  if (parent) nearestPresented.set(node.raw.index, parent);
}

function reindexScopedNodes(
  nodes: readonly IosSnapshotPresentationNode[],
  depthOffset: number,
  depths: ReadonlyMap<number, number>,
): IosSnapshotPresentationNode[] {
  const indexMap = new Map(nodes.map((node, index) => [node.raw.index, index]));
  return nodes.map((node, index) => ({
    ...node,
    raw: {
      ...node.raw,
      index,
      depth: Math.max(0, rawDepth(node, depths) - depthOffset),
      parentIndex:
        node.raw.parentIndex === undefined ? undefined : indexMap.get(node.raw.parentIndex),
    },
  }));
}

function matchesScope(node: RawSnapshotNode, query: string): boolean {
  return [node.label, node.identifier, node.value].some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(query),
  );
}

function subtreeRange(
  nodes: readonly IosSnapshotPresentationNode[],
  start: number,
  depths: ReadonlyMap<number, number>,
): number[] {
  const rootDepth = rawDepth(nodes[start]!, depths);
  const positions: number[] = [];
  for (let position = start; position < nodes.length; position += 1) {
    if (position > start && rawDepth(nodes[position]!, depths) <= rootDepth) break;
    positions.push(position);
  }
  return positions;
}

function rawDepth(node: IosSnapshotPresentationNode, depths?: ReadonlyMap<number, number>): number {
  return Math.max(0, node.raw.depth ?? depths?.get(node.raw.index) ?? 0);
}

function resolveRawDepths(
  nodes: readonly IosSnapshotPresentationNode[],
): ReadonlyMap<number, number> {
  const depths = new Map<number, number>();
  for (const node of nodes) {
    const parentDepth =
      node.raw.parentIndex === undefined ? -1 : (depths.get(node.raw.parentIndex) ?? -1);
    const structuralDepth = parentDepth + 1;
    depths.set(
      node.raw.index,
      node.raw.depth === undefined ? structuralDepth : Math.max(0, node.raw.depth),
    );
  }
  return depths;
}

function hasSemanticContent(node: RawSnapshotNode): boolean {
  return [node.label, node.identifier, node.value].some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}
