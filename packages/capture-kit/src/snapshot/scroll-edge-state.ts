import { AppError } from '@agent-device/kernel/errors';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import type { Point, RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';

export type ScrollEdge = 'top' | 'bottom';

export type ScrollEdgeState = {
  canScroll: boolean;
  emptySnapshot: boolean;
  scope?: string;
  /**
   * A cheap signature of what is on screen right now. Two consecutive captures with the same
   * fingerprint but `canScroll` still true mean the scroll did not move the container — the actuator
   * and the detector disagree, which is the stuck-container signature `runScrollEdgePasses` stops on.
   * Optional so manual capture fixtures can opt out of no-progress detection.
   */
  fingerprint?: string;
};

export type ScrollEdgeTarget = {
  point?: Point;
  nodeIndex?: number;
};

const SCROLL_EDGE_PASS_LIMIT = 40;

/**
 * A stuck or rubber-banding surface revisits the same one or two on-screen signatures, while a real
 * scroll keeps producing a new signature every pass. Once a short window has held at most two
 * distinct signatures for enough passes, the gesture is not reaching the container and further
 * flings only bounce — stop long before the 40-pass backstop. Rounded-pixel signatures make a real
 * pass always look new, so this never cuts a scroll that actually moved.
 */
const SCROLL_EDGE_STUCK_WINDOW = 6;
const SCROLL_EDGE_STUCK_MIN_LENGTH = 4;
const SCROLL_EDGE_STUCK_MAX_DISTINCT = 2;

export async function captureScrollEdgeState(params: {
  edge: ScrollEdge;
  target?: ScrollEdgeTarget;
  scope?: string;
  captureNodes: (scope?: string) => Promise<readonly (RawSnapshotNode | SnapshotNode)[]>;
}): Promise<ScrollEdgeState> {
  const { edge, target = {}, scope, captureNodes } = params;
  try {
    const nodes = await captureNodes(scope);
    const { analyzeScrollEdgeState } = await import('./scroll-edge-state/selection.ts');
    const state = analyzeScrollEdgeState(nodes, edge, target);
    if (scope && state.emptySnapshot) {
      return await captureScrollEdgeState({ edge, target, captureNodes });
    }
    return state;
  } catch (error) {
    throw buildScrollEdgeVerificationError(edge, scope, error);
  }
}

/**
 * Is there hidden content left at this edge? The same question `runScrollEdgePasses` loops on,
 * exposed for callers with their own stop condition (`scroll --until`) so both read one signal.
 */
export async function canScrollFurtherAtEdge(
  nodes: readonly (RawSnapshotNode | SnapshotNode)[],
  edge: ScrollEdge,
): Promise<boolean> {
  const { analyzeScrollEdgeState } = await import('./scroll-edge-state/selection.ts');
  return analyzeScrollEdgeState(nodes, edge).canScroll;
}

/**
 * The on-screen signature the `--until` loop tracks to notice a stuck container, computed the same
 * way `captureScrollEdgeState` derives it, so both loops read one signal. Pure: no capture happens.
 */
export async function scrollSurfaceFingerprint(
  nodes: readonly (RawSnapshotNode | SnapshotNode)[],
  edge: ScrollEdge,
): Promise<string> {
  const { analyzeScrollEdgeState } = await import('./scroll-edge-state/selection.ts');
  return analyzeScrollEdgeState(nodes, edge).fingerprint ?? '';
}

/**
 * Has a scroll stopped making progress? True once `recentSignatures` holds at least
 * `SCROLL_EDGE_STUCK_MIN_LENGTH` captures within the last `SCROLL_EDGE_STUCK_WINDOW`, no more than
 * two are distinct, AND the newest capture is one the window already showed — the signature of a
 * container that ignores the gesture or only rubber-bands. A newest signature the window has not seen
 * is a pass that just made real progress, so `A,A,A,B` continues while `A,B,A,B` is stuck. Callers
 * cap `recentSignatures` to the window. Exported so `scroll --until` reuses the one definition of
 * "stuck" rather than a second copy.
 */
export function scrollSurfaceIsStuck(recentSignatures: readonly string[]): boolean {
  if (recentSignatures.length < SCROLL_EDGE_STUCK_MIN_LENGTH) return false;
  const window = recentSignatures.slice(-SCROLL_EDGE_STUCK_WINDOW);
  if (new Set(window).size > SCROLL_EDGE_STUCK_MAX_DISTINCT) return false;
  const newest = window.at(-1);
  return newest !== undefined && window.slice(0, -1).includes(newest);
}

/**
 * Records one pass's surface signature, capped to the trailing window the stuck detector reads. An
 * empty signature is skipped so a container with no positioned descendants stays on its edge/pass
 * signals instead of stacking blanks. Both scroll loops push through here so "one window" has one
 * definition rather than a copy that can drift.
 */
export function pushScrollSurfaceSignature(
  recentSignatures: string[],
  fingerprint: string | undefined,
  window: number,
): void {
  if (!fingerprint) return;
  recentSignatures.push(fingerprint);
  if (recentSignatures.length > window) recentSignatures.shift();
}

export async function runScrollEdgePasses<TResult>(params: {
  edge: ScrollEdge;
  captureState: (scope?: string) => Promise<ScrollEdgeState>;
  scroll: () => Promise<TResult>;
  /**
   * Waits for the previous fling to come to rest before the next capture. A rubber-banded scroll
   * moves back and forth for a beat after a fling; capturing mid-bounce makes every pass look new and
   * the next fling lands on top of the bounce, compounding it. Default no-op keeps this loop
   * device-free; the daemon supplies a real rest-wait.
   */
  settleAfterPass?: () => Promise<void>;
}): Promise<{ passes: number; result?: TResult }> {
  const { edge, captureState, scroll, settleAfterPass = async () => {} } = params;
  let state = await captureState();
  if (state.scope) {
    state = await captureState(state.scope);
  }

  let passes = 0;
  let result: TResult | undefined;
  const recentSignatures: string[] = [];
  pushScrollSurfaceSignature(recentSignatures, state.fingerprint, SCROLL_EDGE_STUCK_WINDOW);
  while (state.canScroll) {
    if (passes >= SCROLL_EDGE_PASS_LIMIT) {
      throw new AppError(
        'COMMAND_FAILED',
        `scroll ${edge} reached the safety limit before the snapshot showed the edge`,
        {
          reason: 'scroll_edge_pass_limit',
          edge,
          passes,
          hint: 'The scoped scroll container still reports hidden content. Run scroll <dir> --until <selector> to stop on the element you are after, or snapshot -i to inspect the current state.',
        },
      );
    }

    result = await scroll();
    passes += 1;
    await settleAfterPass();
    state = await captureState(state.scope);

    pushScrollSurfaceSignature(recentSignatures, state.fingerprint, SCROLL_EDGE_STUCK_WINDOW);
    if (state.canScroll && scrollSurfaceIsStuck(recentSignatures)) {
      throw buildScrollEdgeNoProgressError(edge, passes);
    }
  }

  return { passes, result };
}

/**
 * `honoredPixels` is the travel the gesture planner actually produced, which is not always the
 * travel that was asked for: one gesture cannot cross more than the viewport axis minus its edge
 * padding, so a large `amount` saturates. Naming the honored distance is what keeps
 * `scroll down 3` from reporting a three-viewport scroll it never performed.
 */
export function formatScrollEdgeMessage(params: {
  direction: ScrollDirection;
  edge?: ScrollEdge | undefined;
  passes: number;
  amount?: number | undefined;
  pixels?: number | undefined;
  honoredPixels?: number | undefined;
}): string {
  const { direction, edge, passes, amount, pixels, honoredPixels } = params;
  if (edge && passes === 0) {
    return `Already at ${edge}; no hidden content ${edge === 'bottom' ? 'below' : 'above'} detected`;
  }
  if (edge) return `Scrolled to ${edge} with ${passes} ${direction} passes`;
  if (pixels !== undefined) return `Scrolled ${direction} by ${honoredPixels ?? pixels}px`;
  if (amount !== undefined) {
    return honoredPixels === undefined
      ? `Scrolled ${direction} by ${amount}`
      : `Scrolled ${direction} by ${amount} of the viewport (${honoredPixels}px)`;
  }
  return `Scrolled ${direction}`;
}

function buildScrollEdgeNoProgressError(edge: ScrollEdge, passes: number): AppError {
  const spent = `${passes} ${passes === 1 ? 'pass' : 'passes'}`;
  return new AppError(
    'COMMAND_FAILED',
    `scroll ${edge} moved nothing across ${spent}: the container still reports hidden content but its contents never shifted`,
    {
      reason: 'scroll_edge_no_progress',
      edge,
      passes,
      hint:
        `The scroll is not reaching this container. If a field is focused, dismiss the keyboard first; if it is nested inside another scroller, target it directly with scroll <dir> --until <selector>. ` +
        `Some lists ignore synthesized scrolls — a raw drag moves them: swipe x1 y1 x2 y2 started inside the list.`,
    },
  );
}

function buildScrollEdgeVerificationError(
  edge: ScrollEdge,
  scope: string | undefined,
  cause: unknown,
): AppError {
  if (scope) {
    return new AppError(
      'COMMAND_FAILED',
      `Failed to verify scroll ${edge} state for scoped container`,
      {
        scope,
        hint: `scroll ${edge} could not verify the scoped scroll container. Run snapshot -i for the current screen and retry with a visible scroll target.`,
      },
      cause,
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `Failed to verify scroll ${edge} state`,
    {
      hint: `scroll ${edge} needs a snapshot showing hidden content ${edge === 'bottom' ? 'below' : 'above'} before it will move.`,
    },
    cause,
  );
}
