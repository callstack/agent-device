import type {
  AndroidSnapshotCaptureMode,
  AndroidSnapshotHelperInstallReason,
  AndroidSnapshotHelperMetadata,
  AndroidSnapshotHelperTransport,
} from './snapshot-helper-types.ts';

/**
 * One Android capture as the host holds it: the tree, the backend metadata the response publishes,
 * and the raw helper transport metadata behind it. The helper pair (display extent, density) rides
 * as raw transport facts rather than as a pre-derived viewport, so the single place that answers the
 * viewport question is `snapshotAndroid`, through the shared guard. The backend metadata stays free
 * of a second copy of the display read: the response publishes that fact once, as `viewport` (#3182).
 */
export type AndroidUiHierarchyCapture = {
  xml: string;
  metadata: AndroidSnapshotBackendMetadata;
  helperMetadata: AndroidSnapshotHelperMetadata;
};

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
