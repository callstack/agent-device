import { readSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import { AppError } from '@agent-device/kernel/errors';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type {
  RawSnapshotNode,
  SnapshotNode,
  SnapshotQualityVerdict,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { isLegacySparseIosInteractiveSnapshot } from '@agent-device/selectors/absence-observation';
import { resolveSelectorPipeline } from '@agent-device/selectors/selector-pipeline';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import {
  canScrollFurtherAtEdge,
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

type CapturedNodes = readonly (RawSnapshotNode | SnapshotNode)[];

/**
 * The capture shape this route receives. The verdict is read under both spellings a capture can
 * carry it in — `SnapshotState` says `snapshotQuality`, a backend result says `quality` and may
 * nest a state as well — because normalizing at the call site is what let a real sparse verdict go
 * unread once already.
 */
export type ScrollUntilCapture = {
  nodes?: CapturedNodes | undefined;
  backend?: string | undefined;
  snapshotQuality?: SnapshotQualityVerdict | undefined;
  quality?: unknown;
  snapshot?: {
    nodes?: CapturedNodes | undefined;
    backend?: string | undefined;
    snapshotQuality?: SnapshotQualityVerdict | undefined;
  };
};

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
  capture: () => Promise<ScrollUntilCapture>;
  scroll: () => Promise<TResult>;
}): Promise<{ passes: number; result?: TResult }> {
  const { selector, direction, platform, capture, scroll } = params;
  const passLimit = params.passLimit ?? SCROLL_UNTIL_PASS_LIMIT;
  const edge = verticalEdgeFor(direction);
  let passes = 0;
  let result: TResult | undefined;

  while (true) {
    const canonical = canonicalCapture(await capture());
    const refusal = captureRefusal(canonical.nodes, canonical.quality, canonical.backend);
    if (refusal) throw scrollUntilCaptureError(direction, selector, refusal);
    const nodes = canonical.nodes ?? [];
    if (await isSelectorVisible(nodes, selector, platform)) {
      return { passes, ...(result === undefined ? {} : { result }) };
    }
    if (edge && !(await canScrollFurtherAtEdge(nodes, edge))) {
      throw scrollUntilNotFoundError(direction, selector, 'edge-reached', passes);
    }
    if (passes >= passLimit) {
      throw scrollUntilNotFoundError(direction, selector, 'pass-limit', passes);
    }
    result = await scroll();
    passes += 1;
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
 * Does this selector match a node that is on screen right now?
 *
 * Two questions, not one: the `wait` pipeline row answers presence and ignores off-screen, then
 * `isVisibleOnScreen` answers the part `--until` cares about. Reusing the presence row unchanged is
 * what keeps a present-but-scrolled-out target from ending the loop early. SOME match, not the
 * first: a list whose rows share a selector can hold an off-screen twin above the fold.
 */
async function isSelectorVisible(
  nodes: CapturedNodes,
  selector: string,
  platform: Platform | PublicPlatform,
): Promise<boolean> {
  const tree = nodes as SnapshotNode[];
  const outcome = await resolveSelectorPipeline(SELECTOR_PIPELINE_POLICIES.wait, tree, selector, {
    platform,
  });
  const matched =
    outcome.kind === 'target' || outcome.kind === 'ambiguous'
      ? outcome.matchedNodes
      : outcome.kind === 'occluded'
        ? [outcome.node]
        : [];
  if (matched.length === 0) return false;
  const visibility = createSnapshotVisibility(tree);
  return matched.some((node) => visibility.isVisibleOnScreen(node));
}

/**
 * Sparseness reuses the signals absence assertions already trust rather than a second definition of
 * readable. Truncation is deliberately NOT refused: a truncated tree is real and readable with its
 * tail missing, and refusing it would fail large screens where the target is plainly in view.
 */
function captureRefusal(
  nodes: CapturedNodes | undefined,
  quality: SnapshotQualityVerdict | undefined,
  backend: string | undefined,
): ScrollUntilCaptureRefusal | undefined {
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

/** The nested state wins on nodes and backend; the verdict comes from whichever level carries one. */
function canonicalCapture(capture: ScrollUntilCapture): {
  nodes: CapturedNodes | undefined;
  backend: string | undefined;
  quality: SnapshotQualityVerdict | undefined;
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
