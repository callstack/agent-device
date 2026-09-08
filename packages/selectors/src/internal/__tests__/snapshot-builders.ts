import {
  attachRefs,
  type RawSnapshotNode,
  type SnapshotState,
  type SnapshotStateProvenance,
} from '@agent-device/kernel/snapshot';

export function buildNodes(raw: RawSnapshotNode[]) {
  return attachRefs(raw);
}

export function makeSnapshotState(
  raw: RawSnapshotNode[],
  // The provenance pair stays correlated: overrides carry it as one value, never as two
  // independently typed fields.
  overrides?: Omit<Partial<SnapshotState>, 'backend' | 'producer'> & SnapshotStateProvenance,
): SnapshotState {
  return {
    nodes: attachRefs(raw),
    createdAt: Date.now(),
    ...overrides,
  };
}
