import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

export type LinuxSnapshotSurface = 'desktop' | 'frontmost-app';

export type LinuxTraversalOptions = {
  maxNodes?: number;
  maxDepth?: number;
  maxApps?: number;
  signal?: AbortSignal;
};

export type LinuxAccessibilityTree = {
  nodes: RawSnapshotNode[];
  truncated: boolean;
  surface: LinuxSnapshotSurface;
};
