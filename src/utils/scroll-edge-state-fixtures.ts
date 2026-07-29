import {
  captureScrollEdgeState,
  type ScrollEdgeState,
  type ScrollEdgeTarget,
} from './scroll-edge-state.ts';
import { AppError } from '../kernel/errors.ts';
import type { RawSnapshotNode, SnapshotNode } from '../kernel/snapshot.ts';

export function windowRoot(): SnapshotNode {
  return {
    ref: 'e1',
    index: 0,
    depth: 0,
    type: 'Window',
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

export async function scopeFor(node: Partial<SnapshotNode>): Promise<string | undefined> {
  const nodes = [
    windowRoot(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      hiddenContentBelow: true,
      rect: { x: 0, y: 100, width: 400, height: 600 },
      ...node,
    },
  ];
  return (await capture(nodes, 'bottom')).scope;
}

export function scrollSnapshot(hiddenContentBelow: boolean): SnapshotNode[] {
  return [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      label: 'Messages',
      hiddenContentBelow: hiddenContentBelow ? true : undefined,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'Button',
      label: hiddenContentBelow ? 'Middle message' : 'Latest message',
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
