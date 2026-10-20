import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import {
  DEFAULT_SCROLL_UNTIL_PASSES,
  SCROLL_UNTIL_MAX_PASSES,
} from '@agent-device/contracts/scroll-command';
import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { sparseCaptureQuality } from '@agent-device/selectors/absence-observation';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import { evaluateIsPredicate } from '@agent-device/selectors';
import { resolveSelectorPipeline } from '@agent-device/selectors/selector-pipeline';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import {
  readScrollEdgeState,
  runScrollPasses,
  scrollNoProgressHint,
  verticalEdgeFor,
  type ScrollCaptureRefusal,
} from '@agent-device/capture-kit/scroll-edge-state';

/**
 * Everything `scroll --until <selector>` needs beyond the ordinary scroll: when a pass has arrived,
 * when the capture cannot answer that at all, and how the two failures read.
 *
 * One module beside the route that runs it. `scroll` reaches a device in exactly one place (ADR
 * 0019, `scroll-runtime.ts`), so there is no second caller to keep in agreement and no reason for
 * this to be a package surface. `scroll top`/`scroll bottom` borrow `scrollCaptureRefusal` from
 * here so both loops share one definition of readable without loading another module.
 */

/**
 * Scrolls until the selector matches a node that is on screen.
 *
 * Each pass reads the tree once and that read answers three questions in order: is the capture
 * usable, has the target arrived, and is there anywhere left to go. Refusing an unusable capture
 * first is what keeps a failed read from being reported as end-of-content — coercing it to an empty
 * tree makes the edge analyzer say "no room below".
 *
 * The end-of-content signal is the one `scroll top`/`scroll bottom` already trust, so both stop in
 * the same place. Horizontal scrolls have no such analyzer and are bounded by the pass budget alone.
 * The first capture happens before the first gesture, so an already-visible target costs no scroll.
 */
export async function runScrollUntilVisible<TResult>(params: {
  selector: string;
  direction: ScrollDirection;
  platform: Platform | PublicPlatform;
  signal?: AbortSignal;
  passLimit?: number;
  capture: () => Promise<SnapshotResult>;
  scroll: () => Promise<TResult>;
}): Promise<{ passes: number; result?: TResult }> {
  const { selector, direction, platform, capture, scroll } = params;
  const edge = verticalEdgeFor(direction);
  let scrolled = false;
  try {
    const { passes, result } = await runScrollPasses({
      signal: params.signal,
      observe: capture,
      accept: (captured) => {
        const refusal = scrollCaptureRefusal(captured);
        if (refusal) throw scrollUntilCaptureError(direction, selector, refusal);
        return captured.nodes as SnapshotNode[];
      },
      decide: async (nodes, passes) => {
        if (await isSelectorVisible(nodes, selector, platform)) return { stop: true };
        // Horizontal scrolling has no edge analyzer and uses only the pass budget.
        if (!edge) return { stop: false };
        const state = await readScrollEdgeState(nodes, edge);
        if (!state.canScroll) {
          throw scrollUntilNotFoundError(direction, selector, 'edge-reached', passes);
        }
        return { stop: false, fingerprint: state.fingerprint };
      },
      passLimit: params.passLimit ?? DEFAULT_SCROLL_UNTIL_PASSES,
      passLimitError: (passes) =>
        scrollUntilNotFoundError(direction, selector, 'pass-limit', passes),
      noProgressError: (passes) => scrollUntilNoProgressError(direction, selector, passes),
      scroll: async () => {
        scrolled = true;
        return await scroll();
      },
    });
    return { passes, ...(result === undefined ? {} : { result }) };
  } catch (error) {
    if (!scrolled && error instanceof AppError) throw discloseDispatch(error, 'no');
    throw error;
  }
}

export function formatScrollUntilMessage(
  direction: ScrollDirection,
  selector: string,
  passes: number,
): string {
  if (passes === 0) return `${selector} was already visible; no ${direction} scroll needed`;
  return `Scrolled ${direction} ${passes} ${passes === 1 ? 'pass' : 'passes'} until ${selector} was visible`;
}

/**
 * Does this selector match a node that is visible right now?
 *
 * Two questions, not one: the `wait` pipeline row answers presence and ignores off-screen, then
 * `is visible`'s own predicate answers the rest. Borrowing that predicate rather than a narrower
 * geometry check is what keeps `scroll --until X` from stopping on a node that `is visible X` would
 * then reject — it carries the Android `visibleToUser` rule, non-positive rects, the hittable
 * fallback and anchor resolution too. SOME match, not the first: a list whose rows share a selector
 * can hold an off-screen twin above the fold.
 */
async function isSelectorVisible(
  nodes: SnapshotNode[],
  selector: string,
  platform: Platform | PublicPlatform,
): Promise<boolean> {
  const outcome = await resolveSelectorPipeline(SELECTOR_PIPELINE_POLICIES.wait, nodes, selector, {
    platform,
  });
  const matched =
    outcome.kind === 'target' || outcome.kind === 'ambiguous'
      ? outcome.matchedNodes
      : outcome.kind === 'occluded'
        ? [outcome.node]
        : [];
  // One index for every candidate from this capture, so the rows a shared selector matched do not
  // each rebuild the node map and viewport rects of the same tree (#1970).
  const visibility = createSnapshotVisibility(nodes);
  return matched.some(
    (node) => evaluateIsPredicate({ predicate: 'visible', node, visibility, platform }).pass,
  );
}

/**
 * Whether a scroll capture can answer anything at all, for every scroll loop. Sparseness is the
 * question absence assertions ask, answered by the same helper rather than a second definition of
 * readable. Truncation is deliberately NOT refused: a truncated tree is real and readable with its
 * tail missing, and refusing it would fail large screens where the answer is plainly in view.
 */
export function scrollCaptureRefusal(result: SnapshotResult): ScrollCaptureRefusal | undefined {
  const nodes = result.nodes;
  // Sparseness first: a backend that names why its tree is unusable (the Android helper's
  // presentation failure ships no nodes and a sparse verdict) gives the better answer.
  const sparse = sparseCaptureQuality({
    backend: result.backend as SnapshotState['backend'],
    nodes: (nodes ?? []) as SnapshotNode[],
    ...(result.quality ? { snapshotQuality: result.quality } : {}),
  });
  if (sparse) {
    return {
      reason: 'sparse-tree',
      detail: sparse.reason ?? 'the capture backend reported a sparse tree',
    };
  }
  if (nodes === undefined) {
    return { reason: 'no-capture', detail: 'the capture returned no accessibility tree' };
  }
  if (nodes.length === 0) {
    return { reason: 'no-capture', detail: 'the capture returned an empty accessibility tree' };
  }
  return undefined;
}

/** The content ran out, or the budget did. Separate messages: the corrective action differs. */
function scrollUntilNotFoundError(
  direction: ScrollDirection,
  selector: string,
  outcome: 'edge-reached' | 'pass-limit',
  passes: number,
): AppError {
  const spent = `${passes} ${passes === 1 ? 'pass' : 'passes'}`;
  if (outcome === 'edge-reached') {
    return new AppError(
      'COMMAND_FAILED',
      `scroll ${direction} reached the end of the scrollable content after ${spent} without ${selector} becoming visible`,
      {
        reason: 'scroll_until_edge_reached',
        selector,
        direction,
        passes,
        hint: `The content ends here, so no further ${direction} scroll can reveal it. Run snapshot -i to see what is on screen, scroll the opposite direction, or check the selector — the element may be on another screen.`,
      },
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `scroll ${direction} spent its ${passes}-pass budget without ${selector} becoming visible`,
    {
      reason: 'scroll_until_pass_limit',
      selector,
      direction,
      passes,
      hint: `Allow more gestures with --max-passes <n> (up to ${SCROLL_UNTIL_MAX_PASSES}), raise the step with an amount (scroll ${direction} 0.8 --until <selector>), or run snapshot -i to inspect the current screen.`,
    },
  );
}

/** The scroll was not reaching the container, not just falling short of a budget — the fix differs. */
function scrollUntilNoProgressError(
  direction: ScrollDirection,
  selector: string,
  passes: number,
): AppError {
  const spent = `${passes} ${passes === 1 ? 'pass' : 'passes'}`;
  return new AppError(
    'COMMAND_FAILED',
    `scroll ${direction} --until ${selector} moved nothing across ${spent}: the on-screen content never shifted`,
    {
      reason: 'scroll_until_no_progress',
      selector,
      direction,
      passes,
      hint: scrollNoProgressHint(),
    },
  );
}

function scrollUntilCaptureError(
  direction: ScrollDirection,
  selector: string,
  refusal: ScrollCaptureRefusal,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `scroll ${direction} --until ${selector} could not read the screen: ${refusal.detail}`,
    {
      reason: 'scroll_until_capture_unreadable',
      selector,
      direction,
      captureRefusal: refusal.reason,
      hint:
        refusal.reason === 'no-capture'
          ? 'Run snapshot -i to see whether the app is producing an accessibility tree at all, and retry once it does.'
          : 'The accessibility tree came back sparse, so its refs and selectors are not trustworthy. Run screenshot, inspect the image, and navigate by coordinates until snapshot -i reports a full tree.',
    },
  );
}
