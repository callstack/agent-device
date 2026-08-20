import {
  buildScrollGesturePlan,
  DEFAULT_IOS_SCROLL_AMOUNT,
  DEFAULT_IOS_SCROLL_DURATION_MS,
  type ScrollDirection,
  type ScrollExecutionOptions,
  type ScrollReleaseBehavior,
} from '@agent-device/contracts/interaction';

export type NormalizedScrollOptions = {
  amount?: number;
  pixels?: number;
  durationMs?: number;
  preferProvidedPixels?: boolean;
};

export type AppleScrollOptions = ScrollExecutionOptions;

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

  return {
    ...(x1 !== undefined ? { x1 } : {}),
    ...(y1 !== undefined ? { y1 } : {}),
    ...(x2 !== undefined ? { x2 } : {}),
    ...(y2 !== undefined ? { y2 } : {}),
    ...(referenceWidth !== undefined ? { referenceWidth } : {}),
    ...(referenceHeight !== undefined ? { referenceHeight } : {}),
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
