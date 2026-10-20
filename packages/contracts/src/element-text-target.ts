import type { SnapshotNode } from '@agent-device/kernel/snapshot';

/** Identity carried from a resolved node into its live text read. */
export type ElementTextTarget = Pick<SnapshotNode, 'identifier' | 'bundleId' | 'type'>;
