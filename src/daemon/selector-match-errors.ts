import type { FindLocator } from '@agent-device/selectors';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { formatSnapshotLine } from '../snapshot/snapshot-lines.ts';
import type { ElementMatchCandidateDetails } from '@agent-device/kernel/errors';
import type { DaemonResponse } from './types.ts';
import { errorResponse } from './response.ts';

// #1597: an agent reading an ambiguous-match error must be able to act on the
// right @ref immediately, without a follow-up snapshot round trip. Candidate
// lines reuse the exact snapshot-line renderer (`formatSnapshotLine`) so a
// candidate reads identically to its row in `snapshot -i` output: ref, role,
// label/identifier. Capped at AMBIGUOUS_MATCH_CANDIDATE_LIMIT to bound the
// error payload — `matches` (the true total) is what a "+N more" marker is
// computed from at render time by the surface owners.
// Module-local: no consumer outside this file needs the raw cap, only the
// already-capped `candidates` array on the response.
const AMBIGUOUS_MATCH_CANDIDATE_LIMIT = 5;

// Exported as the single AMBIGUOUS_MATCH producer so the help-benchmark
// sample parity test renders the exact error this handler returns; a message
// change here fails that gate instead of drifting past it.
export function buildAmbiguousMatchError(
  matches: SnapshotState['nodes'],
  locator: FindLocator,
  query: string,
): DaemonResponse {
  const candidateDetails: ElementMatchCandidateDetails = {
    matches: matches.length,
    candidates: matches
      .slice(0, AMBIGUOUS_MATCH_CANDIDATE_LIMIT)
      .map((candidate) => formatSnapshotLine(candidate, 0, false)),
  };
  return errorResponse(
    'AMBIGUOUS_MATCH',
    `find matched ${matches.length} elements for ${locator} "${query}". Use a more specific locator or selector.`,
    { locator, query, ...candidateDetails },
  );
}
