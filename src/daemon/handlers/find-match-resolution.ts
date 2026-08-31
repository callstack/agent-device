import {
  findBestMatchesByLocator,
  type FindLocator,
  type SelectorResolutionPolicy,
} from '@agent-device/selectors';
import { listSelectorPipelineMatches } from '../../core/selector-pipeline.ts';
import { SELECTOR_PIPELINE_POLICIES } from '../../core/selector-pipeline-policy.ts';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { isRootInteractionContainer } from '../../core/interaction-targeting.ts';
import { preferOnscreenMatches } from './find-match-ranking.ts';
import { formatSnapshotLine } from '../../snapshot/snapshot-lines.ts';
import type { ElementMatchCandidateDetails } from '@agent-device/kernel/errors';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { errorResponse } from '../response.ts';

export type FindMatchResult =
  | { ok: true; node: SnapshotState['nodes'][number] }
  | { ok: false; response: DaemonResponse };

function assertRejectsCandidates(policy: SelectorResolutionPolicy): void {
  if (policy.ambiguity !== 'reject-candidates') {
    throw new Error(`find's resolution policy must reject candidates, got "${policy.ambiguity}"`);
  }
}

export function resolveFindMatch(params: {
  nodes: SnapshotState['nodes'];
  locator: FindLocator;
  query: string;
  selectorExpression: string | null;
  flags: DaemonRequest['flags'];
  platform: SessionState['device']['platform'];
}): FindMatchResult {
  const { nodes, locator, query, selectorExpression, flags, platform } = params;
  const pipeline = SELECTOR_PIPELINE_POLICIES.findAct;
  const rooted = nodes.filter((node) => !isRootInteractionContainer(node, nodes[0]));
  // #1625: selector-shaped and text-shaped queries share ONE ambiguity
  // contract — multiple matches reject with candidates unless --first/--last
  // explicitly opts into positional narrowing. Selectors used to take the
  // first match silently, which was exactly the mis-binding path the error's
  // own recovery advice ("use a selector") pointed agents at.
  const policy = pipeline.resolution;
  let matches: SnapshotState['nodes'];
  if (selectorExpression) {
    // The `reject-candidates` door: the row's candidacy stage runs inside, and
    // the whole candidate set comes back for find to rank and narrow.
    matches =
      listSelectorPipelineMatches(pipeline, rooted, selectorExpression, { platform }).list
        ?.matchedNodes ?? [];
  } else {
    // Fuzzy text scoring, not a selector chain: this branch brings its own
    // matcher and reads the row's rect requirement. The row still governs the
    // target it produces — occlusion and promotion run on it below, in the
    // same node stages the selector branch reaches.
    matches = findBestMatchesByLocator(rooted, locator, query, {
      requireRect: policy.requireRect,
    }).matches;
  }
  matches = preferOnscreenMatches(matches, nodes);

  if (matches.length > 1) {
    // The row says candidates reject unless the caller narrowed explicitly;
    // assert that rather than assuming, so a future row edit cannot silently
    // turn this into first-match.
    assertRejectsCandidates(policy);
    const narrowed = narrowMultipleMatches(matches, flags);
    if (!narrowed) {
      return { ok: false, response: buildAmbiguousMatchError(matches, locator, query) };
    }
    matches = narrowed;
  }

  const node = matches[0] ?? null;
  if (!node) {
    return {
      ok: false,
      response: errorResponse('COMMAND_FAILED', 'find did not match any element'),
    };
  }
  return { ok: true, node };
}

function narrowMultipleMatches(
  matches: SnapshotState['nodes'],
  flags: DaemonRequest['flags'],
): SnapshotState['nodes'] | null {
  if (flags?.findFirst) return [matches[0]!];
  if (flags?.findLast) return [matches.at(-1)!];
  return null;
}

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
