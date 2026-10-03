import type {
  AndroidSnapshotCaptureMode,
  AndroidSnapshotHelperInstallReason,
  AndroidSnapshotHelperTransport,
} from './snapshot-helper-types.ts';

export type AndroidSnapshotBackendMetadata = {
  backend: 'android-helper';
  /**
   * Physical pixels per density-independent pixel of the display the bounds are measured on, as
   * the helper's `DisplayMetrics` report it (2.625 on a 420 dpi phone). Node rects and the points
   * `press` takes stay in physical pixels; a consumer that lays out in dp divides by it. Absent on
   * an older helper.
   */
  pixelDensity?: number;
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
