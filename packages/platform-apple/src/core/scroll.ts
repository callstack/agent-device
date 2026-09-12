import {
  DEFAULT_IOS_SCROLL_AMOUNT,
  DEFAULT_IOS_SCROLL_DURATION_MS,
  type ScrollExecutionOptions,
  type ScrollReleaseBehavior,
} from '@agent-device/contracts/scroll-command';
import {
  type ScrollDirection,
  buildScrollGesturePlan,
  scrollKeyboardOccludesSurfaceError,
} from '@agent-device/contracts/scroll-gesture';
import { AppError } from '@agent-device/kernel/errors';
import { SCROLL_KEYBOARD_OCCLUDES_SURFACE_RUNNER_CODE } from '../runner/runner-contract.ts';

export type NormalizedScrollOptions = {
  amount?: number;
  pixels?: number;
  durationMs?: number;
  preferProvidedPixels?: boolean;
};

export type AppleScrollOptions = ScrollExecutionOptions;

/**
 * Turns the runner's keyboard-occlusion refusal into the reason a caller acts on (#2500).
 *
 * The runner owns the live keyboard frame and declines to place a swipe it cannot keep above the
 * keys; it answers with a typed runner code rather than prose so nothing here has to read an error
 * message. The numbers stay on the runner's side of the boundary — re-deriving them from a frame
 * this process does not hold would be a second source of truth — so the reason and hint are the
 * evidence, joined to whatever the transport already recorded (`logPath`, `runnerErrorCode`).
 */
export function withAppleScrollKeyboardOcclusion(
  error: unknown,
  direction: ScrollDirection,
): unknown {
  if (!(error instanceof AppError)) return error;
  if (error.details?.['runnerErrorCode'] !== SCROLL_KEYBOARD_OCCLUDES_SURFACE_RUNNER_CODE) {
    return error;
  }
  const refusal = scrollKeyboardOccludesSurfaceError(direction);
  return new AppError(refusal.code, refusal.message, {
    ...(error.details ?? {}),
    ...(refusal.details ?? {}),
  });
}

export function materializeIosScrollOptions(
  options: AppleScrollOptions | undefined,
): AppleScrollOptions {
  const hasExplicitDistance = options?.amount !== undefined || options?.pixels !== undefined;
  return {
    ...options,
    ...(!hasExplicitDistance ? { amount: DEFAULT_IOS_SCROLL_AMOUNT } : {}),
    durationMs: options?.durationMs ?? DEFAULT_IOS_SCROLL_DURATION_MS,
    releaseBehavior: options?.releaseBehavior ?? 'controlled',
  };
}

export function normalizeAppleScrollResultWithResolvedFrame(
  runnerResult: Record<string, unknown>,
  direction: ScrollDirection,
  options?: AppleScrollOptions,
  config: { includeDuration?: boolean } = { includeDuration: true },
): Record<string, unknown> {
  const referenceWidth = readFiniteNumber(runnerResult.referenceWidth);
  const referenceHeight = readFiniteNumber(runnerResult.referenceHeight);
  if (referenceWidth === undefined || referenceHeight === undefined) {
    return normalizeAppleScrollResult(runnerResult, { amount: options?.amount });
  }

  // Recompute the plan from the runner's resolved frame so reported pixels match the planned
  // travel (TS keeps buildScrollGesturePlan for Android and recording anyway).
  const plan = buildScrollGesturePlan({
    direction,
    amount: options?.amount,
    pixels: options?.pixels,
    referenceWidth,
    referenceHeight,
  });
  return normalizeAppleScrollResult(runnerResult, {
    amount: options?.amount,
    pixels: plan.pixels,
    durationMs: config?.includeDuration ? options?.durationMs : undefined,
    preferProvidedPixels: true,
  });
}

export function scrollRunnerFields(
  options: AppleScrollOptions | undefined,
  config: { includeDuration?: boolean; includeReleaseBehavior?: boolean } = {},
): Record<string, number | ScrollReleaseBehavior> {
  return {
    ...(options?.amount !== undefined ? { amount: options.amount } : {}),
    ...(options?.pixels !== undefined ? { pixels: options.pixels } : {}),
    ...(config.includeDuration !== false && options?.durationMs !== undefined
      ? { durationMs: options.durationMs }
      : {}),
    ...(config.includeReleaseBehavior !== false && options?.releaseBehavior !== undefined
      ? { scrollReleaseBehavior: options.releaseBehavior }
      : {}),
  };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeAppleScrollResult(
  runnerResult: Record<string, unknown>,
  options?: NormalizedScrollOptions,
): Record<string, unknown> {
  const { x1, y1, x2, y2 } = remapRunnerCoordinates(runnerResult);
  const referenceWidth = readFiniteNumber(runnerResult.referenceWidth);
  const referenceHeight = readFiniteNumber(runnerResult.referenceHeight);
  const horizontalTravel =
    x1 !== undefined && x2 !== undefined ? Math.round(Math.abs(x2 - x1)) : undefined;
  const verticalTravel =
    y1 !== undefined && y2 !== undefined ? Math.round(Math.abs(y2 - y1)) : undefined;
  const travelPixels = selectScrollTravelPixels(options, horizontalTravel, verticalTravel);
  const keyboardMinY = readFiniteNumber(runnerResult.keyboardMinY);

  return {
    ...(x1 !== undefined ? { x1 } : {}),
    ...(y1 !== undefined ? { y1 } : {}),
    ...(x2 !== undefined ? { x2 } : {}),
    ...(y2 !== undefined ? { y2 } : {}),
    ...(referenceWidth !== undefined ? { referenceWidth } : {}),
    ...(referenceHeight !== undefined ? { referenceHeight } : {}),
    // Avoidance evidence (#2500) is reported only when it happened: `referenceHeight` above already
    // names the clipped axis, and a plain `false` here could not tell "no keyboard" apart from a
    // platform that never runs the clip.
    ...(runnerResult.keyboardAvoided === true ? { keyboardAvoided: true } : {}),
    ...(keyboardMinY !== undefined ? { keyboardMinY } : {}),
    ...(options?.amount !== undefined ? { amount: options.amount } : {}),
    ...(travelPixels !== undefined ? { pixels: travelPixels } : {}),
    ...(options?.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
  };
}

function selectScrollTravelPixels(
  options: NormalizedScrollOptions | undefined,
  horizontalTravel: number | undefined,
  verticalTravel: number | undefined,
): number | undefined {
  if (options?.preferProvidedPixels && options.pixels !== undefined) return options.pixels;
  if (horizontalTravel !== undefined && horizontalTravel > 0) return horizontalTravel;
  if (verticalTravel !== undefined && verticalTravel > 0) return verticalTravel;
  return undefined;
}

function remapRunnerCoordinates(runnerResult: Record<string, unknown>): {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
} {
  const x = readFiniteNumber(runnerResult.x);
  const y = readFiniteNumber(runnerResult.y);
  const x2 = readFiniteNumber(runnerResult.x2);
  const y2 = readFiniteNumber(runnerResult.y2);
  return {
    ...(x !== undefined ? { x1: x } : {}),
    ...(y !== undefined ? { y1: y } : {}),
    ...(x2 !== undefined ? { x2 } : {}),
    ...(y2 !== undefined ? { y2 } : {}),
  };
}
