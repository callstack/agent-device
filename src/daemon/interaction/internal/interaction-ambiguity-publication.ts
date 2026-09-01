import { AppError, readElementMatchCandidateRefs } from '@agent-device/kernel/errors';

export function publishInteractionAmbiguityCandidates(params: {
  error: AppError;
  snapshotGeneration: number | undefined;
  publishPartialRefs: (refs: readonly string[]) => void;
}): AppError {
  const { error, snapshotGeneration, publishPartialRefs } = params;
  if (error.code !== 'AMBIGUOUS_MATCH') return error;
  const refs = readElementMatchCandidateRefs(error.details);
  if (refs.length === 0 || snapshotGeneration === undefined) return error;

  publishPartialRefs(refs);
  return new AppError(
    error.code,
    error.message,
    { ...error.details, refsGeneration: snapshotGeneration },
    error.cause,
  );
}
