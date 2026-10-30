import { AppError } from '@agent-device/kernel/errors';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotAddressableNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SelectorResolution } from '@agent-device/selectors';
import { resolveActionSelectorPipeline } from '@agent-device/selectors/selector-pipeline';
import type { ActingPipelinePolicy } from '@agent-device/selectors/selector-pipeline-policy';
import { elementMatchCandidateDetails } from '@agent-device/capture-kit/snapshot-lines';

export type ActionSelectorResolution = SelectorResolution<SnapshotAddressableNode>;

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
): ActionSelectorResolution | null {
  const outcome = resolveActionSelectorPipeline(policy, nodes, selectorExpression, { platform });
  if (outcome.kind === 'none') return null;
  if (outcome.kind === 'ambiguous') {
    throw new AppError(
      'AMBIGUOUS_MATCH',
      `Selector matched ${outcome.candidates.length} distinct actionable elements: ${outcome.selector}`,
      {
        selector: outcome.selector,
        ...elementMatchCandidateDetails(outcome.candidates),
      },
    );
  }
  return outcome.resolution;
}
