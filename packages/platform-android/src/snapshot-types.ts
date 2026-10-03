import type { SnapshotViewportSize } from '@agent-device/kernel/snapshot';
import type {
  AndroidSnapshotCaptureMode,
  AndroidSnapshotHelperInstallReason,
  AndroidSnapshotHelperTransport,
} from './snapshot-helper-types.ts';

/**
 * One Android capture as the host holds it: the tree, the helper facts behind it, and the screen the
 * bounds are measured in (#3182). The viewport is a sibling rather than a field of `metadata` because
 * the metadata travels to the response, where the same fact is already published once as `viewport`;
 * carrying the raw display pair further than this boundary would leave two copies with different
 * lifetimes. Absent when the helper's own display read answered with nothing usable.
 */
export type AndroidUiHierarchyCapture = {
  xml: string;
  metadata: AndroidSnapshotBackendMetadata;
  viewport?: SnapshotViewportSize;
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
