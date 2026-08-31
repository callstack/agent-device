import { AppError, readElementMatchCandidateRefs } from '@agent-device/kernel/errors';
import { markSessionPartialRefsIssued } from '../session-snapshot.ts';
import type { SessionState } from '../types.ts';

/**
 * An ambiguity rejection captured a real snapshot but performed no mutation.
 * Publish only its bounded candidate refs and attach the frame epoch so CLI
 * callers can paste pinned refs and MCP can pin plain refs transparently.
 */
export function publishInteractionAmbiguityCandidates(
  session: SessionState,
  error: AppError,
): AppError {
  if (error.code !== 'AMBIGUOUS_MATCH') return error;
  const refs = readElementMatchCandidateRefs(error.details);
  if (refs.length === 0 || session.snapshotGeneration === undefined) return error;

  markSessionPartialRefsIssued(session, refs);
  return new AppError(
    error.code,
    error.message,
    { ...error.details, refsGeneration: session.snapshotGeneration },
    error.cause,
  );
}
