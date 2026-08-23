import type {
  AndroidSnapshotCaptureMode,
  AndroidSnapshotHelperInstallReason,
  AndroidSnapshotHelperTransport,
} from './snapshot-helper-types.ts';

export type AndroidSnapshotBackendMetadata = {
  backend: 'android-helper';
  helperVersion?: string;
  helperApiVersion?: string;
  helperTransport?: AndroidSnapshotHelperTransport;
  helperSessionReused?: boolean;
  installReason?: AndroidSnapshotHelperInstallReason;
  waitForIdleTimeoutMs?: number;
  waitForIdleQuietMs?: number;
  timeoutMs?: number;
  maxDepth?: number;
  maxNodes?: number;
  rootPresent?: boolean;
  captureMode?: AndroidSnapshotCaptureMode;
  systemSurfaceOnly?: boolean;
  windowCount?: number;
  nodeCount?: number;
  helperTruncated?: boolean;
  elapsedMs?: number;
  presentationFailure?: {
    phase: 'deadline' | 'complexity' | 'regular-invariant';
    workUnits: number;
    maxWorkUnits?: number;
  };
  /** API 23 exposes no sibling drawing order, so same-window occlusion fails conservative. */
  occlusionScanUnavailable?: boolean;
};
