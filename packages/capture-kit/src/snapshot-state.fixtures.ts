import {
  attachRefs,
  type RawSnapshotNode,
  type SnapshotState,
  type SnapshotStateProvenance,
} from '@agent-device/kernel/snapshot';

// fallow-ignore-next-line code-duplication
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
