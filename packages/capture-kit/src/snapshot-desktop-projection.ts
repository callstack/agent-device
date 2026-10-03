import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotOptions, SnapshotResult } from '@agent-device/contracts/interactor-types';
import {
  findSnapshotScopeRange,
  normalizeSnapshotScope,
  reindexSnapshotNodes,
} from '@agent-device/contracts/snapshot-scope';

const INTERACTIVE_ROLE_TOKENS = [
  'button',
  'menu',
  'textfield',
  'searchfield',
  'checkbox',
  'radio',
  'switch',
] as const;

export function shapeDesktopSurfaceSnapshot(
  data: SnapshotResult,
  options: Pick<SnapshotOptions, 'depth' | 'interactiveOnly' | 'scope'>,
): SnapshotResult {
  let nodes = data.nodes ?? [];
  if (options.scope) {
    nodes = scopeSnapshotNodes(nodes, options.scope, (range) =>
      options.interactiveOnly
        ? nodes.slice(range.start, range.end).some(isInteractiveSnapshotNode)
        : true,
    );
  }
  if (options.interactiveOnly) nodes = filterInteractiveSnapshotNodes(nodes);
  if (typeof options.depth === 'number') nodes = filterSnapshotNodesByDepth(nodes, options.depth);
  return { ...data, nodes };
}

export function scopeSnapshotNodes(
  nodes: RawSnapshotNode[],
  scope: string,
  subtreeContributes?: (range: { start: number; end: number }) => boolean,
): RawSnapshotNode[] {
  const normalizedScope = normalizeSnapshotScope(scope);
  if (!normalizedScope) return reindexSnapshotNodes(nodes);
  const range = findSnapshotScopeRange(nodes, normalizedScope, subtreeContributes);
  if (!range) return [];
  const slice = nodes.slice(range.start, range.end);
  return reindexSnapshotNodes(slice, slice[0]?.depth ?? 0);
}

function filterInteractiveSnapshotNodes(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  if (nodes.length === 0) return nodes;
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const keepIndexes = new Set<number>();
  for (const node of nodes) {
    if (!isInteractiveSnapshotNode(node)) continue;
    let current: RawSnapshotNode | undefined = node;
    while (current) {
      if (keepIndexes.has(current.index)) break;
      keepIndexes.add(current.index);
      current =
        typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
    }
  }
  if (keepIndexes.size === 0) return nodes;
  return reindexSnapshotNodes(nodes.filter((node) => keepIndexes.has(node.index)));
}

function filterSnapshotNodesByDepth(nodes: RawSnapshotNode[], maxDepth: number): RawSnapshotNode[] {
  return reindexSnapshotNodes(nodes.filter((node) => (node.depth ?? 0) <= maxDepth));
}

function isInteractiveSnapshotNode(node: RawSnapshotNode): boolean {
  if ([node.focused, node.hittable, node.rect].some(Boolean)) return true;
  const role = `${node.type ?? ''} ${node.role ?? ''} ${node.subrole ?? ''}`.toLowerCase();
  return INTERACTIVE_ROLE_TOKENS.some((token) => role.includes(token));
}
