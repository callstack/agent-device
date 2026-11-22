import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  narrowFindMatches,
  type FindLocator,
  type SelectorResolutionPolicy,
} from '@agent-device/selectors';
import { findOneNodeCandidates } from '@agent-device/selectors/selector-pipeline';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { buildAmbiguousMatchError } from '../../selector-match-errors.ts';
import { errorResponse } from '@agent-device/kernel/contracts';

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
  // #1625: selector-shaped and text-shaped queries share ONE ambiguity
  // contract — multiple matches reject with candidates unless --first/--last
  // explicitly opts into positional narrowing. `find <q> get text|attrs`
  // counts the same candidate set (#4685).
  const pipeline = SELECTOR_PIPELINE_POLICIES.findAct;
  const policy = pipeline.resolution;
  let matches = findOneNodeCandidates({
    pipeline,
    nodes,
    locator,
    query,
    selectorExpression,
    platform,
  });

  if (matches.length > 1) {
    // The row says candidates reject unless the caller narrowed explicitly;
    // assert that rather than assuming, so a future row edit cannot silently
    // turn this into first-match.
    assertRejectsCandidates(policy);
    const narrowed = narrowFindMatches(matches, flags);
    if (!narrowed) {
      return { ok: false, response: buildAmbiguousMatchError(matches, locator, query) };
    }
    matches = [narrowed];
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
