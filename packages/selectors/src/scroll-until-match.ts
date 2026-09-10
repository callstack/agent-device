import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import type { ScrollUntilCaptureRefusal } from '@agent-device/capture-kit/scroll-until-visible';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type {
  RawSnapshotNode,
  SnapshotNode,
  SnapshotQualityVerdict,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { isLegacySparseIosInteractiveSnapshot } from './absence-observation.ts';
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

/** The fields a `--until` pass can read from either route's capture without reshaping it. */
export type ScrollUntilCapture = {
  nodes?: readonly (RawSnapshotNode | SnapshotNode)[] | undefined;
  /** Widened to `string` because the backend capture result carries it untyped. */
  backend?: string | undefined;
  snapshotQuality?: SnapshotQualityVerdict | undefined;
};

/**
 * Whether this capture can answer the `--until` question, asked before the selector match and
 * before the edge analyzer.
 *
 * Both callers previously coerced a missing tree to `[]`, which the vertical edge analyzer reads as
 * "no room below" — so a capture that failed reported end-of-content. Refusing here keeps that
 * inference from ever being drawn from a tree nobody could read.
 *
 * Sparseness reuses the same signals absence assertions already trust, rather than a second
 * definition of "readable": the backend's own quality verdict, then the legacy iOS shape that
 * predates it. Truncation is deliberately NOT refused — a truncated tree is a real, readable tree
 * whose tail is missing, and refusing it would fail large screens where the target is plainly in
 * view.
 */
export function scrollUntilCaptureRefusal(
  capture: ScrollUntilCapture,
): ScrollUntilCaptureRefusal | undefined {
  const nodes = capture.nodes;
  if (nodes === undefined) {
    return { reason: 'no-capture', detail: 'the capture returned no accessibility tree' };
  }
  if (nodes.length === 0) {
    return { reason: 'no-capture', detail: 'the capture returned an empty accessibility tree' };
  }
  const quality = capture.snapshotQuality;
  if (quality?.state === 'sparse') {
    return {
      reason: 'sparse-tree',
      detail: quality.reason ?? 'the capture backend reported a sparse tree',
    };
  }
  if (
    isLegacySparseIosInteractiveSnapshot({
      backend: capture.backend as SnapshotState['backend'],
      nodes: nodes as SnapshotNode[],
      ...(quality ? { snapshotQuality: quality } : {}),
    })
  ) {
    return { reason: 'sparse-tree', detail: 'the capture exposed only the application root' };
  }
  return undefined;
}
