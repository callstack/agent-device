import { attachRefs, type RawSnapshotNode, type SnapshotState } from '../../kernel/snapshot.ts';

export function buildNodes(raw: RawSnapshotNode[]) {
  return attachRefs(raw);
}

export function makeSnapshotState(
  raw: RawSnapshotNode[],
  overrides?: Partial<SnapshotState>,
): SnapshotState {
  return {
    nodes: attachRefs(raw),
    createdAt: Date.now(),
    ...overrides,
  };
}
