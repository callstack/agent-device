export type SnapshotDiffLine = {
  kind: 'added' | 'removed' | 'unchanged';
  text: string;
  /**
   * Plain ref body (`e12`) of the current-tree node behind an added line.
   * Only populated with `withRefs`; removed and unchanged lines never carry it.
   */
  ref?: string;
};
export type SnapshotDiffSummary = {
  additions: number;
  removals: number;
  unchanged: number;
};

export type DiffSnapshotCommandResult = {
  mode: 'snapshot';
  baselineInitialized: boolean;
  summary: SnapshotDiffSummary;
  lines: SnapshotDiffLine[];
  warnings?: string[];
};
