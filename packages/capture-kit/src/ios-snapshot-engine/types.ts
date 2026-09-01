import type { Rect, RawSnapshotNode } from '@agent-device/kernel/snapshot';

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
}>;

export type IosSnapshotEnginePresentation = Readonly<{
  nodes: RawSnapshotNode[];
  qualityNodes?: RawSnapshotNode[];
  presentedIndexesBySourceIndex: ReadonlyMap<number, readonly number[]>;
  stats: IosSnapshotPresentationStats;
}>;

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
