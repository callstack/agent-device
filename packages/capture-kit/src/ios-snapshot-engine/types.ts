import type { Rect, RawSnapshotNode, SnapshotQualityNote } from '@agent-device/kernel/snapshot';

export type IosSnapshotFoldPolicy = 'cursor-projected' | 'plain-viewport';

export type IosSnapshotEngineOptions = Readonly<{
  foldPolicy?: IosSnapshotFoldPolicy;
}>;

export type IosSnapshotFoldOptions = Readonly<{
  hittabilityAvailable?: boolean;
}>;

export type IosSnapshotPresentationNode = Readonly<{
  raw: RawSnapshotNode;
  sourceIndex: number;
  effectiveRect?: Rect;
}>;

export type IosSnapshotPresentationStats = Readonly<{
  presentedNodeCount: number;
  sourceNodeCount: number;
  parentClipLookups: number;
  /** Sources the presentation cut removed because a later modal presentation dims them. */
  modalContainedNodeCount: number;
}>;

export type IosSnapshotEnginePresentation = Readonly<{
  nodes: RawSnapshotNode[];
  /**
   * The box the regular projection validated this tree against (#3182). The fold already resolves it
   * (`resolveIosViewport` / `resolveViewportEvidence`), so the engine hands it over instead of making
   * every caller re-derive "regular validates a box, raw does not". A raw projection validates no box
   * and carries none.
   */
  validatedViewport?: Rect;
  qualityNodes?: RawSnapshotNode[];
  qualityNotes?: SnapshotQualityNote[];
  presentedIndexesBySourceIndex: ReadonlyMap<number, readonly number[]>;
  stats: IosSnapshotPresentationStats;
}>;

/**
 * The tree whose node numbering an {@link IosSnapshotEngineFailureDetails} `index` and `parentIndex`
 * count in. One capture is numbered several times over — the raw acquisition, the tree the Apple
 * runner published to the host, and the tree the host publishes after its own compaction — and every
 * renumbering shifts a node, so a refusal that names an index without its tree asks the reader to
 * guess which tree to open (#4701).
 *
 * Each value says where to read the node:
 * - `acquired` — the raw acquisition tree, the numbering an unscoped `snapshot --raw` lists.
 * - `presented` — the tree this snapshot command publishes. A capture of the same screen that
 *   passes lists the node at this index.
 * - `runner-payload` — the tree the Apple runner published for this request. A passing plain
 *   `snapshot` publishes that tree at these same numbers. `snapshot -i` compacts it and renumbers
 *   what survives, and a refusal raised in that renumbered tree reads `presented` instead.
 * - `runner-quality-payload` — the runner's unscoped quality payload, which no projection lists.
 */
export type IosSnapshotIndexTree =
  | 'acquired'
  | 'presented'
  | 'runner-payload'
  | 'runner-quality-payload';

export type IosSnapshotEngineFailureReason =
  | 'projection-mismatch'
  | 'missing-viewport'
  | 'invalid-viewport'
  | 'malformed-graph'
  | 'regular-node-outside-cumulative-clip'
  | 'regular-degenerate-actionable-node'
  | 'invalid-presented-payload'
  | 'invalid-quality-payload';

export type IosSnapshotEngineFailureDetails = Readonly<{
  index?: number;
  parentIndex?: number;
  /** {@link IosSnapshotIndexTree} the `index` above counts in. Set on every refusal that names a node. */
  indexTree?: IosSnapshotIndexTree;
  frame?: Rect;
  clip?: Rect;
  projection?: string;
  field?: string;
}>;

export class IosSnapshotEngineError extends Error {
  readonly code = 'IOS_SNAPSHOT_ENGINE_FAILED';
  readonly reason: IosSnapshotEngineFailureReason;
  readonly details: IosSnapshotEngineFailureDetails;

  constructor(
    reason: IosSnapshotEngineFailureReason,
    message: string,
    details: IosSnapshotEngineFailureDetails = {},
  ) {
    super(message);
    this.name = 'IosSnapshotEngineError';
    this.reason = reason;
    this.details = details;
  }
}

export type IosSnapshotEnginePublicErrorDetails = Readonly<
  IosSnapshotEngineFailureDetails & { reason: IosSnapshotEngineFailureReason }
>;

export function toIosSnapshotEngineErrorDetails(
  error: IosSnapshotEngineError,
): IosSnapshotEnginePublicErrorDetails {
  return { reason: error.reason, ...error.details };
}
