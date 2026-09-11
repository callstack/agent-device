import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import { AppError } from '@agent-device/kernel/errors';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { evaluateIsPredicate } from '@agent-device/selectors';
import { sparseCaptureQuality } from '@agent-device/selectors/absence-observation';
import { resolveSelectorPipeline } from '@agent-device/selectors/selector-pipeline';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import {
  canScrollFurtherAtEdge,
  pushScrollSurfaceSignature,
  scrollSurfaceFingerprint,
  scrollSurfaceIsStuck,
  type ScrollEdge,
} from '@agent-device/capture-kit/scroll-edge-state';

/**
 * Everything `scroll --until <selector>` needs beyond the ordinary scroll: when a pass has arrived,
 * when the capture cannot answer that at all, and how the two failures read.
 *
 * One module beside the route that runs it. `scroll` reaches a device in exactly one place (ADR
 * 0019, `scroll-runtime.ts`), so there is no second caller to keep in agreement and no reason for
 * this to be a package surface.
 */

/**
 * How many gestures one `scroll --until` may spend before it gives up. A pass costs a capture plus
 * a gesture, so this is the request's whole cost ceiling, not a retry budget: 12 passes at the
 * honored 0.8-viewport maximum cover roughly ten screens, which is past the point where a list is
 * better reached by `scroll bottom` or a search field.
 */
export const SCROLL_UNTIL_PASS_LIMIT = 12;

/**
 * Cap for the vertical stuck-signature window fed to `scrollSurfaceIsStuck`. Matches the capture-kit
 * edge loop so both loops notice a stuck container after the same handful of non-advancing passes.
 */
const SCROLL_UNTIL_STUCK_WINDOW = 6;

/** Why a capture cannot answer the `--until` question at all. Never an outcome about the content. */
type ScrollUntilCaptureRefusal = { reason: 'no-capture' | 'sparse-tree'; detail: string };

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
  passLimit?: number;
  capture: () => Promise<SnapshotResult>;
  scroll: () => Promise<TResult>;
}): Promise<{ passes: number; result?: TResult }> {
  const { selector, direction, platform, capture, scroll } = params;
  const passLimit = params.passLimit ?? SCROLL_UNTIL_PASS_LIMIT;
  const edge = verticalEdgeFor(direction);
  let passes = 0;
  let result: TResult | undefined;
  const recentSignatures: string[] = [];

  while (true) {
    const decision = await decideUntilPass({
      captured: await capture(),
      selector,
      direction,
      platform,
      edge,
      passes,
      passLimit,
      recentSignatures,
    });
    if (decision.visible) {
      return { passes, ...(result === undefined ? {} : { result }) };
    }
    result = await scroll();
    passes += 1;
  }
}

/**
 * What one capture tells us about the `--until` loop, answered in the order that matters: refuse an
 * unusable read, report an arrived target, then the two ways a pass cannot usefully continue. Every
 * terminal condition raises its own typed error; a non-terminal pass returns `{ visible: false }` so
 * the caller flings once more and asks again. The stuck window mutates in place so the loop keeps one
 * running history across passes.
 */
async function decideUntilPass(params: {
  captured: SnapshotResult;
  selector: string;
  direction: ScrollDirection;
  platform: Platform | PublicPlatform;
  edge: ScrollEdge | undefined;
  passes: number;
  passLimit: number;
  recentSignatures: string[];
}): Promise<{ visible: boolean }> {
  const { captured, selector, direction, platform, edge, passes, passLimit, recentSignatures } =
    params;
  const refusal = captureRefusal(captured);
  if (refusal) throw scrollUntilCaptureError(direction, selector, refusal);
  const nodes = (captured.nodes ?? []) as SnapshotNode[];
  if (await isSelectorVisible(nodes, selector, platform)) {
    return { visible: true };
  }
  if (edge && !(await canScrollFurtherAtEdge(nodes, edge))) {
    throw scrollUntilNotFoundError(direction, selector, 'edge-reached', passes);
  }
  if (passes >= passLimit) {
    throw scrollUntilNotFoundError(direction, selector, 'pass-limit', passes);
  }
  if (edge) {
    // Vertical only: a stuck container revisits the same one or two signatures. Checked after the
    // pass-limit branch so an explicit small budget still reports `scroll_until_pass_limit`.
    pushScrollSurfaceSignature(
      recentSignatures,
      await scrollSurfaceFingerprint(nodes, edge),
      SCROLL_UNTIL_STUCK_WINDOW,
    );
    if (scrollSurfaceIsStuck(recentSignatures)) {
      throw scrollUntilNoProgressError(direction, selector, passes);
    }
  }
  return { visible: false };
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
  return matched.some(
    (node) => evaluateIsPredicate({ predicate: 'visible', node, nodes, platform }).pass,
  );
}

/**
 * Sparseness is the same question absence assertions ask, answered by the same helper rather than a
 * second definition of readable. Truncation is deliberately NOT refused: a truncated tree is real
 * and readable with its tail missing, and refusing it would fail large screens where the target is
 * plainly in view.
 */
function captureRefusal(result: SnapshotResult): ScrollUntilCaptureRefusal | undefined {
  const nodes = result.nodes;
  if (nodes === undefined) {
    return { reason: 'no-capture', detail: 'the capture returned no accessibility tree' };
  }
  if (nodes.length === 0) {
    return { reason: 'no-capture', detail: 'the capture returned an empty accessibility tree' };
  }
  const sparse = sparseCaptureQuality({
    backend: result.backend as SnapshotState['backend'],
    nodes: nodes as SnapshotNode[],
    ...(result.quality ? { snapshotQuality: result.quality } : {}),
  });
  if (sparse) {
    return {
      reason: 'sparse-tree',
      detail: sparse.reason ?? 'the capture backend reported a sparse tree',
    };
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
      hint: `Raise the step with an amount (scroll ${direction} 0.8 --until <selector>), or run snapshot -i to confirm the selector matches something on this screen.`,
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
      hint:
        `The scroll is not reaching this container. If a field is focused, dismiss the keyboard first; if it is nested inside another scroller, target it directly. ` +
        `Some lists ignore synthesized scrolls — a raw drag moves them: swipe x1 y1 x2 y2 started inside the list.`,
    },
  );
}

function scrollUntilCaptureError(
  direction: ScrollDirection,
  selector: string,
  refusal: ScrollUntilCaptureRefusal,
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

/**
 * The end-of-content analyzer only reads vertical edges, so a horizontal `--until` is bounded by its
 * pass budget alone rather than by a signal that would always report "no room".
 */
function verticalEdgeFor(direction: ScrollDirection): ScrollEdge | undefined {
  if (direction === 'down') return 'bottom';
  if (direction === 'up') return 'top';
  return undefined;
}
