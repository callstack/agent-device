export type ArtifactDescriptor = Record<string, unknown>;
export type ScreenshotDiffResult = {
  diffPath?: string;
  totalPixels: number;
  differentPixels: number;
  mismatchPercentage: number;
  match: boolean;
  currentOverlayPath?: string;
  currentOverlayRefCount?: number;
  regions?: Array<{ currentOverlayMatches?: Array<{ ref?: string }> }>;
};
export type SnapshotDiffLine = {
  kind: 'added' | 'removed' | 'unchanged';
  text: string;
  ref?: string;
};
export type SnapshotDiffSummary = { additions: number; removals: number; unchanged: number };

export type DiffScreenshotCommandResult = ScreenshotDiffResult & {
  artifacts?: ArtifactDescriptor[];
};

export type DiffSnapshotCommandResult = {
  mode: 'snapshot';
  baselineInitialized: boolean;
  summary: SnapshotDiffSummary;
  lines: SnapshotDiffLine[];
  warnings?: string[];
};
