import type {
  IosSnapshotEngineError,
  IosSnapshotEngineFailureDetails,
  IosSnapshotEngineFailureReason,
} from './types.ts';

export type IosSnapshotEnginePublicErrorDetails = Readonly<
  IosSnapshotEngineFailureDetails & { reason: IosSnapshotEngineFailureReason }
>;

export function toIosSnapshotEngineErrorDetails(
  error: IosSnapshotEngineError,
): IosSnapshotEnginePublicErrorDetails {
  return {
    reason: error.reason,
    ...(error.details.index !== undefined ? { index: error.details.index } : {}),
    ...(error.details.parentIndex !== undefined ? { parentIndex: error.details.parentIndex } : {}),
    ...(error.details.frame !== undefined ? { frame: error.details.frame } : {}),
    ...(error.details.clip !== undefined ? { clip: error.details.clip } : {}),
    ...(error.details.projection !== undefined ? { projection: error.details.projection } : {}),
    ...(error.details.field !== undefined ? { field: error.details.field } : {}),
  };
}
