import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';

export function buildNodes(raw: RawSnapshotNode[]) {
  return attachRefs(raw);
}
