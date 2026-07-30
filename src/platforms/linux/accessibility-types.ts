import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

export type LinuxSnapshotSurface = 'desktop' | 'frontmost-app';

export type LinuxTraversalOptions = {
  maxNodes?: number;
  maxDepth?: number;
  maxApps?: number;
};

export type LinuxAccessibilityTree = {
  nodes: RawSnapshotNode[];
  truncated: boolean;
  surface: LinuxSnapshotSurface;
};
