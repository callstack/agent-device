import { AppError } from '@agent-device/kernel/errors';
import type { SettleObservation } from './interaction.ts';
import type { ScrollDirection } from './scroll-gesture.ts';

export const SCROLL_DURATION_MAX_MS = 10_000;
export const DEFAULT_MOBILE_SCROLL_DURATION_MS = 300;
export const DEFAULT_IOS_SCROLL_DURATION_MS = 400;
export const DEFAULT_IOS_SCROLL_AMOUNT = 0.65;

export type ScrollReleaseBehavior = 'controlled' | 'inertial';

/**
 * What a directional scroll actually SAW after its gesture, which is the only evidence that can
 * back the distance the same response reports (#2714).
 *
 * - `'moved'`: the post-gesture surface differs from the pre-gesture one, so content did move.
 * - `'at-edge'`: the surface is identical and the resolved container names no hidden content in
 *   that direction — the scroll was a legitimate no-op at the end of the content.
 * - `'unchanged'`: the surface is identical and the direction has no end-of-content signal to read
 *   (a horizontal scroll: the hidden-content analyzer only covers the vertical axis), so the
 *   response says what it measured without guessing which of the two it was.
 * - `'unobserved'`: nothing comparable was available, so the distance rests on the gesture plan
 *   alone. Callers that need the effect confirmed ask for a capture or a `--settle` observation.
 *
 * A directional scroll that measures an unchanged surface WITH hidden content still in that
 * direction does not answer at all: it fails with `scroll_no_progress`.
 */
export type ScrollMovementObservation = 'moved' | 'at-edge' | 'unchanged' | 'unobserved';

export type ScrollDistanceOptions = {
  amount?: number;
  pixels?: number;
};

export type ScrollTimingOptions = {
  durationMs?: number;
};

export type ScrollCommandOptions = ScrollDistanceOptions & ScrollTimingOptions;

export type ScrollExecutionOptions = ScrollCommandOptions & {
  releaseBehavior?: ScrollReleaseBehavior;
};

export type ResolvedScrollExecutionOptions = ScrollCommandOptions & {
  releaseBehavior: ScrollReleaseBehavior;
};

export function resolveScrollExecutionOptions(
  options: ScrollCommandOptions,
  edge?: 'top' | 'bottom',
): ResolvedScrollExecutionOptions {
  return {
    ...options,
    releaseBehavior: edge === undefined ? 'controlled' : 'inertial',
  };
}

export function assertExclusiveScrollDistanceInputs(
  options: ScrollDistanceOptions,
  message = 'scroll accepts either a relative amount or --pixels, not both',
): void {
  if (options.amount !== undefined && options.pixels !== undefined) {
    throw new AppError('INVALID_ARGS', message);
  }
}

/**
 * `top`/`bottom` are scroll-to-extreme requests that already carry a stop condition, so pairing one
 * with `--until` names two and the request has no single meaning. Rejected at the surface rather
 * than resolved by precedence, so neither stop condition can silently win.
 */
export function assertScrollUntilCompatible(
  input: Readonly<{ edge?: 'top' | 'bottom'; until?: string }>,
): void {
  if (input.until === undefined || input.edge === undefined) return;
  throw new AppError(
    'INVALID_ARGS',
    `scroll ${input.edge} already scrolls to the ${input.edge} edge and cannot take --until`,
    {
      hint: `Use scroll ${input.edge === 'bottom' ? 'down' : 'up'} --until <selector> to stop at the target, or scroll ${input.edge} to reach the edge.`,
    },
  );
}

export function normalizeScrollDurationMs(
  durationMs: number | undefined,
  options: { field?: string; invalidMessage?: string; max?: number } = {},
): number | undefined {
  if (durationMs === undefined) return undefined;
  const field = options.field ?? 'scroll durationMs';
  const max = options.max ?? SCROLL_DURATION_MAX_MS;
  const invalidMessage = options.invalidMessage ?? `${field} must be a non-negative integer`;
  if (!Number.isFinite(durationMs) || !Number.isInteger(durationMs) || durationMs < 0) {
    throw new AppError('INVALID_ARGS', invalidMessage);
  }
  if (durationMs > max) {
    throw new AppError('INVALID_ARGS', `${field} must be a non-negative integer at most ${max}`);
  }
  return durationMs;
}

/** The travel the planner produced, which saturates below a large requested amount. */
export function honoredScrollPixels(
  result: Record<string, unknown> | undefined,
): number | undefined {
  return typeof result?.pixels === 'number' ? result.pixels : undefined;
}

export function honoredScrollDurationMs(
  result: Record<string, unknown> | undefined,
): number | undefined {
  return typeof result?.durationMs === 'number' ? result.durationMs : undefined;
}

/**
 * Where the leaf's swipe ran, as the midpoint of the coordinates it reported — the same absolute space
 * its snapshots use, which is what lets a container rect say whether the gesture landed inside it.
 * An owner that reports no coordinates is answered `undefined` rather than guessed at: a tvOS scroll
 * is a remote keypress, so there is no midpoint to name.
 */
export function honoredScrollSwipeMidpoint(
  result: Record<string, unknown> | undefined,
): { x: number; y: number } | undefined {
  const x1 = readReportedCoordinate(result?.x1);
  const y1 = readReportedCoordinate(result?.y1);
  const x2 = readReportedCoordinate(result?.x2);
  const y2 = readReportedCoordinate(result?.y2);
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    return undefined;
  }
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

function readReportedCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `scroll` — the generic-route result built by `buildDispatchedScrollResult`
 * (src/core/dispatch-scroll.ts): the resolved direction, the edge-pass
 * bookkeeping for `top`/`bottom` scrolls, the honored distance/timing echo,
 * and the success message. Platform leaves add gesture-plan coordinates
 * (`x1`/`y1`/`x2`/`y2`, reference frame) on top; the output schema stays
 * non-strict so those additive fields validate. The one field the dispatcher
 * itself may add: `settle`, the opt-in `--settle` observation (#1638),
 * attached after the command — same shape as `BackCommandResult`.
 */
export type ScrollCommandResult = {
  direction: ScrollDirection;
  /** Set for `top`/`bottom` requests: the extreme being scrolled to. */
  edge?: 'top' | 'bottom';
  /** Set for `--until` requests: the selector the passes stopped on. */
  until?: string;
  /** Edge and until scrolls only: how many scroll-and-check passes ran. */
  passes?: number;
  amount?: number;
  pixels?: number;
  durationMs?: number;
  message?: string;
  settle?: SettleObservation;
  /**
   * The observation that gated this response's distance claim. See
   * {@link ScrollMovementObservation}: `scroll` answers with what it measured after the gesture,
   * and only `'moved'` and `'at-edge'` confirm the surface's fate. Absent on the tiers that verify
   * per pass instead of per gesture (`scroll top`/`bottom` and `--until`), and on platforms whose
   * scroll owner never dispatches a swipe (the Linux wheel).
   */
  movement?: ScrollMovementObservation;
  /**
   * Set only when an on-screen keyboard made the owner clip the swipe into the band above it
   * (#2500). Absent means the swipe was not clipped, which is not the same claim as `false`: a
   * platform that never runs the clip has nothing to report. The platform leaf's `referenceHeight`
   * names the shortened axis the reported `pixels` were planned against, and `keyboardMinY` names
   * where the keyboard began. A surface the owner refused to swipe at all fails instead, under the
   * `scroll_keyboard_occludes_surface` reason.
   */
  keyboardAvoided?: true;
  /** The keyboard's edge in the same unit as the gesture coordinates, when the swipe was clipped. */
  keyboardMinY?: number;
};
