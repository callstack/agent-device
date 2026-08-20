import { AppError } from '@agent-device/kernel/errors';

export const SCROLL_DURATION_MAX_MS = 10_000;
export const DEFAULT_MOBILE_SCROLL_DURATION_MS = 300;
export const DEFAULT_IOS_SCROLL_DURATION_MS = 400;
export const DEFAULT_IOS_SCROLL_AMOUNT = 0.65;

export type ScrollReleaseBehavior = 'controlled' | 'inertial';

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

export function honoredScrollDurationMs(
  result: Record<string, unknown> | undefined,
): number | undefined {
  return typeof result?.durationMs === 'number' ? result.durationMs : undefined;
}
