import type { ArtifactDescriptor } from '../io.ts';
import type { ScreenshotDiffResult } from '../screenshot-diff/screenshot-diff.ts';
import type { SnapshotDiffLine, SnapshotDiffSummary } from '../snapshot/snapshot-diff.ts';

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
