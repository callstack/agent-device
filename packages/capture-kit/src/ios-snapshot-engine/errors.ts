import type { IosSnapshotEngineError, IosSnapshotEngineFailureReason } from './types.ts';

export type IosSnapshotEnginePublicErrorDetails = Readonly<{
  reason: IosSnapshotEngineFailureReason;
  field?: string;
}>;

export function toIosSnapshotEngineErrorDetails(
  error: IosSnapshotEngineError,
): IosSnapshotEnginePublicErrorDetails {
  return {
    reason: error.reason,
    ...(error.details.field ? { field: error.details.field } : {}),
  };
}
