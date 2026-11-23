import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  findBestMatchesByLocator,
  type FindAction,
  type FindLocator,
  type SelectorResolutionPolicy,
} from '@agent-device/selectors';
import { listSelectorPipelineMatches } from '@agent-device/selectors/selector-pipeline';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import { isRootInteractionContainer } from '@agent-device/selectors/interaction-targeting';
import { preferOnscreenMatches } from './find-match-ranking.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { buildAmbiguousMatchError } from '../../selector-match-errors.ts';
import { errorResponse } from '@agent-device/kernel/contracts';

const FIND_NO_MATCH_HINT =
  'Run snapshot -i to see current elements and refs, or scroll first if the element may be off-screen.';
// A bare `find <text>` is this action, so an agent that meant a lookup learns the read form here.
const FIND_CLICK_NO_MATCH_HINT = `${FIND_NO_MATCH_HINT} This find clicks its match; to look an element up without acting on it, use find text "..." exists.`;

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
  action: FindAction['kind'];
  selectorExpression: string | null;
  flags: DaemonRequest['flags'];
  platform: SessionState['device']['platform'];
}): FindMatchResult {
  const { nodes, locator, query, action, selectorExpression, flags, platform } = params;
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
      // Nothing was dispatched: a bare `find` defaults to click, which would otherwise read as a
      // mutation that may have reached the device.
      response: errorResponse('COMMAND_FAILED', 'find did not match any element', {
        dispatched: 'no',
        hint: action === 'click' ? FIND_CLICK_NO_MATCH_HINT : FIND_NO_MATCH_HINT,
      }),
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
