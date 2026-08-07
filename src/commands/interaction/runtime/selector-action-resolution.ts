import { AppError } from '@agent-device/kernel/errors';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  resolveSelectorChainWithPolicy,
  SELECTOR_RESOLUTION_POLICIES,
  type SelectorResolution,
} from '@agent-device/selectors';
import { classifyActionableTouchCandidates } from '../../../core/interaction-targeting.ts';
import { formatSnapshotLine } from '../../../snapshot/snapshot-lines.ts';

const AMBIGUOUS_ACTION_CANDIDATE_LIMIT = 5;

/**
 * Fail-fast resolution for mutating selectors. Wrapper duplicates may collapse
 * through structural/actionable equivalence; matches in distinct branches are
 * returned as actionable candidates instead of being ranked by geometry.
 */
export function resolveActionSelector(
  nodes: SnapshotNode[],
  selectorExpression: string,
  platform: Platform | PublicPlatform,
): SelectorResolution | null {
  const outcome = resolveSelectorChainWithPolicy(
    nodes,
    selectorExpression,
    SELECTOR_RESOLUTION_POLICIES.act,
    { platform },
  );
  if (outcome.kind === 'none') return null;
  if (outcome.kind === 'resolved') return outcome.resolution;

  const classification = classifyActionableTouchCandidates(nodes, outcome.matchedNodes);
  if (classification.kind === 'ambiguous') {
    throw new AppError(
      'AMBIGUOUS_MATCH',
      `Selector matched ${classification.candidates.length} distinct actionable elements: ${outcome.selector}`,
      {
        selector: outcome.selector,
        matches: classification.candidates.length,
        candidates: classification.candidates
          .slice(0, AMBIGUOUS_ACTION_CANDIDATE_LIMIT)
          .map((candidate) => formatSnapshotLine(candidate, 0, false)),
      },
    );
  }

  return {
    node: classification.node,
    selector: outcome.selector,
    selectorIndex: outcome.selectorIndex,
    matches: outcome.matchedNodes.length,
    diagnostics: [{ selector: outcome.selector, matches: outcome.matchedNodes.length }],
    disambiguation: {
      matchCount: outcome.matchedNodes.length,
      tiebreak: 'structural-equivalence',
      alternatives: outcome.matchedNodes.filter(
        (candidate) => candidate.index !== classification.node.index,
      ),
    },
  };
}
