import { AppError } from '@agent-device/kernel/errors';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SelectorResolution } from '@agent-device/selectors';
import { classifyActionableTouchCandidates } from '../../../core/interaction-targeting.ts';
import { listSelectorPipelineMatches } from '../../../core/selector-pipeline.ts';
import type { ActingPipelinePolicy } from '../../../core/selector-pipeline-policy.ts';
import { formatSnapshotLine } from '../../../snapshot/snapshot-lines.ts';

const AMBIGUOUS_ACTION_CANDIDATE_LIMIT = 5;

/**
 * How an acting row narrows its candidate set: wrapper duplicates may collapse
 * through structural/actionable equivalence; matches in distinct branches are
 * refused with actionable candidates instead of being ranked by geometry.
 *
 * Both the candidate set and the tree it is judged against come from the
 * pipeline owner, so the row's occlusion stage has already run on both: a
 * covered node is neither a candidate nor a competitor, and an overlay cannot
 * turn one control into an ambiguous pair.
 */
export function resolveActionSelector(
  nodes: SnapshotNode[],
  selectorExpression: string,
  platform: Platform | PublicPlatform,
  policy: ActingPipelinePolicy,
): SelectorResolution | null {
  const { candidates, list } = listSelectorPipelineMatches(policy, nodes, selectorExpression, {
    platform,
  });
  const matched = list?.matchedNodes ?? [];
  if (!list || matched.length === 0) return null;

  const diagnostics = [{ selector: list.selector, matches: matched.length }];
  if (matched.length === 1) {
    return {
      node: matched[0]!,
      selector: list.selector,
      selectorIndex: list.selectorIndex,
      matches: 1,
      diagnostics,
    };
  }

  const classification = classifyActionableTouchCandidates(candidates, matched);
  if (classification.kind === 'ambiguous') {
    throw new AppError(
      'AMBIGUOUS_MATCH',
      `Selector matched ${classification.candidates.length} distinct actionable elements: ${list.selector}`,
      {
        selector: list.selector,
        matches: classification.candidates.length,
        candidates: classification.candidates
          .slice(0, AMBIGUOUS_ACTION_CANDIDATE_LIMIT)
          .map((candidate) => formatSnapshotLine(candidate, 0, false)),
      },
    );
  }

  return {
    node: classification.node,
    selector: list.selector,
    selectorIndex: list.selectorIndex,
    matches: matched.length,
    diagnostics,
    disambiguation: {
      matchCount: matched.length,
      tiebreak: 'structural-equivalence',
      alternatives: matched.filter((candidate) => candidate.index !== classification.node.index),
    },
  };
}
