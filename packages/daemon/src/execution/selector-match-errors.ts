import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { findAmbiguousMatchMessage, type FindLocator } from '@agent-device/selectors';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import { elementMatchCandidateDetails } from '@agent-device/capture-kit/snapshot-lines';
import { errorResponse } from '@agent-device/kernel/contracts';

// The acting find's AMBIGUOUS_MATCH response: the shared message (`findAmbiguousMatchMessage`), the
// #1597 candidates, and the acting route's `dispatched: no`. Exported so the help-benchmark sample
// parity test renders the exact error this handler returns; a message change here fails that gate
// instead of drifting past it.
export function buildAmbiguousMatchError(
  matches: SnapshotState['nodes'],
  locator: FindLocator,
  query: string,
): DaemonResponse {
  return errorResponse(
    'AMBIGUOUS_MATCH',
    findAmbiguousMatchMessage(matches.length, locator, query),
    {
      locator,
      query,
      ...elementMatchCandidateDetails(matches),
      dispatched: 'no',
    },
  );
}

/**
 * The match is one element, but which of its text fields `find focus` or `find type` means is not.
 * It follows find's refusal contract: its message routes the caller to narrow the locator, and it
 * does not pin the printed refs to a generation (see `publishAmbiguousMatchCandidateRefs`).
 */
export function buildNestedTextFieldsError(
  ref: string,
  fields: SnapshotState['nodes'],
): DaemonResponse {
  return errorResponse(
    'AMBIGUOUS_MATCH',
    `find matched ${ref}, which contains ${fields.length} text fields. Use a more specific locator or selector.`,
    { ref, ...elementMatchCandidateDetails(fields), dispatched: 'no' },
  );
}
