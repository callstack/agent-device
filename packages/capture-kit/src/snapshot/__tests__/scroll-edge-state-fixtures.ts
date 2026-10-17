import {
  captureScrollEdgeState,
  type ScrollEdgeState,
  type ScrollEdgeTarget,
} from '../scroll-edge-state.ts';
import { AppError } from '@agent-device/kernel/errors';
import { matchesSnapshotScope, reindexSnapshotNodes } from '@agent-device/contracts/snapshot';
import { formatRole } from '@agent-device/kernel/snapshot';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';

export function windowRoot(): SnapshotNode {
  return {
    ref: 'e1',
    index: 0,
    depth: 0,
    type: 'Window',
    kind: formatRole('Window'),
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };
}

export async function capture(
  nodes: readonly (RawSnapshotNode | SnapshotNode)[],
  edge: 'top' | 'bottom' = 'bottom',
  target?: ScrollEdgeTarget,
): Promise<ScrollEdgeState> {
  return captureScrollEdgeState({
    edge,
    target,
    captureNodes: async () => nodes,
  });
}

/** A `ScrollView` node with the common defaults (top-level, full-width rect) this suite reuses. */
export function scrollNode(index: number, overrides: Partial<SnapshotNode> = {}): SnapshotNode {
  return {
    ref: `e${index + 1}`,
    index,
    parentIndex: 0,
    type: 'ScrollView',
    kind: formatRole('ScrollView'),
    rect: { x: 0, y: 100, width: 400, height: 600 },
    ...overrides,
  };
}

export async function scopeFor(node: Partial<SnapshotNode>): Promise<string | undefined> {
  const nodes = [windowRoot(), scrollNode(1, { hiddenContentBelow: true, ...node })];
  return (await capture(nodes, 'bottom')).scope;
}

export function scrollSnapshot(hiddenContentBelow: boolean): SnapshotNode[] {
  return [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      kind: formatRole('ScrollView'),
      label: 'Messages',
      hiddenContentBelow: hiddenContentBelow ? true : undefined,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'Button',
      kind: formatRole('Button'),
      label: hiddenContentBelow ? 'Middle message' : 'Latest message',
      rect: { x: 0, y: 640, width: 400, height: 56 },
    },
  ];
}

/**
 * A scrolled container whose one visible cell keeps a stable identifier and slot while only its text
 * varies — the recycled-cell shape where identity alone would hide real progress.
 */
export function recycledCellSnapshot(label: string): SnapshotNode[] {
  return [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      kind: formatRole('ScrollView'),
      label: 'Feed',
      hiddenContentBelow: true,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'StaticText',
      kind: formatRole('StaticText'),
      identifier: 'cell-0',
      label,
      rect: { x: 0, y: 640, width: 400, height: 56 },
    },
  ];
}

export async function captureThrows(scope: string | undefined): Promise<AppError> {
  try {
    await captureScrollEdgeState({
      edge: 'bottom',
      scope,
      captureNodes: async () => {
        throw new Error('boom');
      },
    });
    throw new Error('expected captureScrollEdgeState to reject');
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
}

/**
 * The scope root's subtree, reindexed, as an Android scoped snapshot returns it: the first node in
 * document order whose label, value or identifier matches, plus its descendants. Unscoped returns
 * the whole tree.
 */
export function subtreeFor(
  nodes: readonly SnapshotNode[],
  scope: string | undefined,
): SnapshotNode[] {
  if (scope === undefined) return [...nodes];
  const root = nodes.find((node) => matchesSnapshotScope(node, scope));
  if (!root) return [];
  const inScope = new Set([root.index]);
  for (const node of nodes) {
    if (node.parentIndex !== undefined && inScope.has(node.parentIndex)) inScope.add(node.index);
  }
  return reindexSnapshotNodes(nodes.filter((node) => inScope.has(node.index)));
}
