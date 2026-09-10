import { AppError } from '@agent-device/kernel/errors';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import type { ScrollEdge } from './scroll-edge-state.ts';

/**
 * How many gestures one `scroll --until` may spend before it gives up. A pass costs a capture plus
 * a gesture, so this is the request's whole cost ceiling, not a retry budget: 12 passes at the
 * honored 0.8-viewport maximum cover roughly ten screens of content, which is past the point where
 * a list is better reached by `scroll bottom` or a search field.
 */
export const SCROLL_UNTIL_PASS_LIMIT = 12;

/**
 * Why the loop stopped. `matched` is the only success; the other two are the two distinguishable
 * ways a target never came into view, and callers report them differently because the corrective
 * action differs — an exhausted list needs a different direction, an exhausted budget needs a
 * bigger step or a narrower selector.
 */
export type ScrollUntilVisibleOutcome = 'matched' | 'edge-reached' | 'pass-limit';

/**
 * Why a capture cannot answer the `--until` question at all.
 *
 * Distinct from the loop's outcomes on purpose: an unreadable capture is not evidence about the
 * content, and collapsing the two is how `?? []` used to turn a failed read into "you reached the
 * end of the list". The classifier that produces this lives in `@agent-device/selectors`, which is
 * where the same readability question is already answered for absence assertions; the vocabulary
 * lives here beside the outcomes it must not be confused with.
 */
export type ScrollUntilCaptureRefusal = {
  reason: 'no-capture' | 'sparse-tree';
  detail: string;
};

export type ScrollUntilVisibleResult<TResult> = {
  passes: number;
  outcome: ScrollUntilVisibleOutcome;
  result?: TResult;
};

type CapturedNodes = readonly (RawSnapshotNode | SnapshotNode)[];

/**
 * Scrolls until an injected predicate says the target is on screen.
 *
 * The predicate is injected rather than resolved here because the two callers (the daemon's generic
 * scroll route and the in-process command runtime) reach selector matching through different
 * layers; keeping the loop predicate-shaped is what lets both share one definition of when to stop.
 *
 * `edge` is the end-of-content signal, and it is the SAME signal `scroll top`/`scroll bottom`
 * already trust (`analyzeScrollEdgeState`), so a list that reports no room below stops this loop
 * exactly where an edge scroll would stop. Horizontal scrolls have no such analyzer and are bounded
 * by `passLimit` alone.
 *
 * The first capture happens before the first gesture: a target that is already visible costs one
 * capture and zero scrolls.
 */
export async function runScrollUntilVisiblePasses<TResult>(params: {
  edge?: ScrollEdge;
  passLimit?: number;
  captureNodes: () => Promise<CapturedNodes>;
  isVisibleMatch: (nodes: CapturedNodes) => Promise<boolean> | boolean;
  scroll: () => Promise<TResult>;
}): Promise<ScrollUntilVisibleResult<TResult>> {
  const { edge, captureNodes, isVisibleMatch, scroll } = params;
  const passLimit = params.passLimit ?? SCROLL_UNTIL_PASS_LIMIT;
  let passes = 0;
  let result: TResult | undefined;
  const stop = (outcome: ScrollUntilVisibleOutcome): ScrollUntilVisibleResult<TResult> => ({
    passes,
    outcome,
    ...(result === undefined ? {} : { result }),
  });

  while (true) {
    const nodes = await captureNodes();
    if (await isVisibleMatch(nodes)) return stop('matched');
    if (edge && !(await canScrollFurther(nodes, edge))) return stop('edge-reached');
    if (passes >= passLimit) return stop('pass-limit');
    result = await scroll();
    passes += 1;
  }
}

async function canScrollFurther(nodes: CapturedNodes, edge: ScrollEdge): Promise<boolean> {
  const { analyzeScrollEdgeState } = await import('./scroll-edge-state/selection.ts');
  return analyzeScrollEdgeState(nodes, edge).canScroll;
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
 * The two ways the loop can end without the target on screen. They are separate messages because
 * the corrective action differs: content that ran out needs a different direction or a target that
 * is not on this screen at all, while an exhausted budget needs a bigger step or a selector that
 * matches something nearer.
 */
export function scrollUntilNotFoundError(params: {
  direction: ScrollDirection;
  selector: string;
  outcome: Exclude<ScrollUntilVisibleOutcome, 'matched'>;
  passes: number;
}): AppError {
  const { direction, selector, outcome, passes } = params;
  if (outcome === 'edge-reached') {
    return new AppError(
      'COMMAND_FAILED',
      `scroll ${direction} reached the end of the scrollable content after ${passes} ${passes === 1 ? 'pass' : 'passes'} without ${selector} becoming visible`,
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
      hint: `Raise the step with an amount (scroll ${direction} 0.8 --until <selector>), or run snapshot -i to confirm the selector matches something on this screen.`,
    },
  );
}

/**
 * The capture could not be read, so neither the selector match nor the edge analyzer ran. Reported
 * as its own failure rather than as an outcome, because "we could not see the screen" and "the
 * content ran out" call for different next steps.
 */
export function scrollUntilCaptureError(params: {
  direction: ScrollDirection;
  selector: string;
  refusal: ScrollUntilCaptureRefusal;
}): AppError {
  const { direction, selector, refusal } = params;
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
