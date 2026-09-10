import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import type { ScrollUntilCaptureRefusal } from '@agent-device/capture-kit/scroll-until-visible';
import { readSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type {
  RawSnapshotNode,
  SnapshotNode,
  SnapshotQualityVerdict,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
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

/**
 * The fields a `--until` pass can read from either route's capture without reshaping it.
 *
 * The verdict is accepted under BOTH spellings on purpose. A `SnapshotState` calls it
 * `snapshotQuality`; a `BackendSnapshotResult` calls it `quality` and may also carry a nested
 * `snapshot`. Asking each caller to normalize is what let a real backend sparse verdict slip past
 * the first version of this check, so the one place that asks the question reads every spelling
 * the capture can arrive in.
 */
export type ScrollUntilCapture = {
  nodes?: readonly (RawSnapshotNode | SnapshotNode)[] | undefined;
  /** Widened to `string` because the backend capture result carries it untyped. */
  backend?: string | undefined;
  snapshotQuality?: SnapshotQualityVerdict | undefined;
  quality?: unknown;
  snapshot?: {
    nodes?: readonly (RawSnapshotNode | SnapshotNode)[] | undefined;
    backend?: string | undefined;
    snapshotQuality?: SnapshotQualityVerdict | undefined;
  };
};

/**
 * The nested `SnapshotState` wins on nodes and backend, and the verdict is taken from whichever
 * level carries one — selecting `result.snapshot` alone used to drop a top-level `quality`.
 */
function canonicalCapture(capture: ScrollUntilCapture): {
  nodes?: readonly (RawSnapshotNode | SnapshotNode)[] | undefined;
  backend?: string | undefined;
  quality?: SnapshotQualityVerdict | undefined;
} {
  const nested = capture.snapshot;
  return {
    nodes: nested?.nodes ?? capture.nodes,
    backend: nested?.backend ?? capture.backend,
    quality:
      nested?.snapshotQuality ??
      capture.snapshotQuality ??
      readSnapshotQualityVerdict(capture.quality),
  };
}

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
export async function scrollUntilCaptureRefusal(
  capture: ScrollUntilCapture,
): Promise<ScrollUntilCaptureRefusal | undefined> {
  const { nodes, backend, quality } = canonicalCapture(capture);
  if (nodes === undefined) {
    return { reason: 'no-capture', detail: 'the capture returned no accessibility tree' };
  }
  if (nodes.length === 0) {
    return { reason: 'no-capture', detail: 'the capture returned an empty accessibility tree' };
  }
  if (quality?.state === 'sparse') {
    return {
      reason: 'sparse-tree',
      detail: quality.reason ?? 'the capture backend reported a sparse tree',
    };
  }
  // Lazy for the same reason the pipeline edges are: `absence-observation` reaches `ad-script` for
  // work unrelated to this two-line shape check, and paying that closure eagerly would put this
  // module over the entry-surface ceiling.
  const { isLegacySparseIosInteractiveSnapshot } = await import('./absence-observation.ts');
  if (
    isLegacySparseIosInteractiveSnapshot({
      backend: backend as SnapshotState['backend'],
      nodes: nodes as SnapshotNode[],
      ...(quality ? { snapshotQuality: quality } : {}),
    })
  ) {
    return { reason: 'sparse-tree', detail: 'the capture exposed only the application root' };
  }
  return undefined;
}
