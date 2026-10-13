import type { FindLocator } from '@agent-device/selectors';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { elementMatchCandidateDetails } from '@agent-device/capture-kit/snapshot-lines';
import type { DaemonResponse } from './daemon-request.ts';
import { errorResponse } from '@agent-device/kernel/contracts';

// #1597: an agent reading an ambiguous-match error must be able to act on the
// right @ref immediately, without a follow-up snapshot round trip. Candidate
// lines reuse the exact snapshot-line renderer (`formatSnapshotLine`) so a
// candidate reads identically to its row in `snapshot -i` output: ref, role,
// label/identifier. The cap lives in the one builder that fills the disclosure
// (`elementMatchCandidateDetails`), beside the renderer — `matches` (the true
// total) is what a
// "+N more" marker is computed from at render time by the surface owners.
// Exported as the single AMBIGUOUS_MATCH producer so the help-benchmark
// sample parity test renders the exact error this handler returns; a message
// change here fails that gate instead of drifting past it.
export function buildAmbiguousMatchError(
  matches: SnapshotState['nodes'],
  locator: FindLocator,
  query: string,
): DaemonResponse {
  return errorResponse(
    'AMBIGUOUS_MATCH',
    `find matched ${matches.length} elements for ${locator} "${query}". Use a more specific locator or selector.`,
    { locator, query, ...elementMatchCandidateDetails(matches) },
  );
}
