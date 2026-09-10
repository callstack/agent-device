import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SelectorPipelineOutcome } from './selector-pipeline.ts';

/**
 * The stop condition `scroll --until` asks of every capture: does this selector match a node that
 * is on screen right now?
 *
 * One definition for both callers — the daemon's generic scroll route and the in-process command
 * runtime — so the two paths cannot disagree about when a scroll has arrived. It is deliberately
 * two questions, not one: the `wait` pipeline row answers presence and ignores off-screen, then
 * `isVisibleOnScreen` answers the part `--until` actually cares about. Reusing the presence row
 * unchanged is what keeps a target that is present-but-scrolled-out from ending the loop early.
 */
export async function isSelectorVisibleInNodes(params: {
  nodes: readonly (RawSnapshotNode | SnapshotNode)[];
  selector: string;
  platform: Platform | PublicPlatform;
}): Promise<boolean> {
  const nodes = params.nodes as SnapshotNode[];
  if (nodes.length === 0) return false;
  // Both edges are lazy on purpose. The policy table re-enters the package barrel and the pipeline
  // pulls the match engine, which together would make this small predicate a 66-module entry
  // surface for every importer. The loop that calls this awaits anyway, and the module cache makes
  // every pass after the first free.
  const [{ SELECTOR_PIPELINE_POLICIES }, { resolveSelectorPipeline }] = await Promise.all([
    import('./selector-pipeline-policy.ts'),
    import('./selector-pipeline.ts'),
  ]);
  const outcome = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.wait,
    nodes,
    params.selector,
    { platform: params.platform },
  );
  const matched = matchedNodes(outcome);
  if (matched.length === 0) return false;
  const visibility = createSnapshotVisibility(nodes);
  // SOME match, not the first: a list whose rows share a selector can hold an off-screen twin above
  // the fold, and stopping on that twin would leave the target the agent asked for still hidden.
  return matched.some((node) => visibility.isVisibleOnScreen(node));
}

function matchedNodes(outcome: SelectorPipelineOutcome): readonly SnapshotNode[] {
  switch (outcome.kind) {
    case 'target':
    case 'ambiguous':
      return outcome.matchedNodes;
    case 'occluded':
      return [outcome.node];
    case 'none':
      return [];
  }
}
