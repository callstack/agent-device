import type {
  SnapshotNode,
  SnapshotState,
  SnapshotOptions,
  SnapshotQualityVerdict,
  ScreenshotOverlayRef,
} from '@agent-device/kernel/snapshot';
import type { SnapshotDiagnosticsSummary } from './snapshot-diagnostics.ts';

export type ScreenshotResultData = {
  path?: string;
  width?: number;
  height?: number;
  logicalWidth?: number;
  logicalHeight?: number;
  pixelDensity?: number;
  overlayRefs?: ScreenshotOverlayRef[];
};
export type BackendSnapshotResult = {
  nodes?: SnapshotNode[];
  truncated?: boolean;
  backend?: string;
  snapshot?: SnapshotState;
  appName?: string;
  appBundleId?: string;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  analysis?: { rawNodeCount: number; maxDepth: number };
  androidSnapshot?: AndroidSnapshotBackendMetadata;
  freshness?: {
    action: string;
    retryCount: number;
    staleAfterRetries: boolean;
    reason?: 'empty-interactive' | 'sharp-drop' | 'stuck-route';
  };
  quality?: SnapshotQualityVerdict;
  warnings?: string[];
};
export type BackendSnapshotOptions = SnapshotOptions & {
  includeRects?: boolean;
  includeHiddenContentHints?: boolean;
  outPath?: string;
};
export type AndroidSnapshotBackendMetadata = {
  backend: 'android-helper';
  helperVersion?: string;
  helperApiVersion?: string;
  helperTransport?: string;
  helperSessionReused?: boolean;
  installReason?: string;
  waitForIdleTimeoutMs?: number;
  waitForIdleQuietMs?: number;
  timeoutMs?: number;
  maxDepth?: number;
  maxNodes?: number;
  rootPresent?: boolean;
  captureMode?: string;
  systemSurfaceOnly?: boolean;
  windowCount?: number;
  nodeCount?: number;
  helperTruncated?: boolean;
  elapsedMs?: number;
};
export type FindLocator = 'any' | 'text' | 'label' | 'value' | 'role' | 'id';
