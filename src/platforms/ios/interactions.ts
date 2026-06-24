import type { DeviceInfo } from '../../utils/device.ts';
import {
  assertScrollGestureInput,
  buildScrollGesturePlan,
  SCROLL_DURATION_MAX_MS,
  type ScrollDirection,
} from '../../core/scroll-gesture.ts';
import { AppError } from '../../utils/errors.ts';
import { runIosRunnerCommand } from './runner-client.ts';
import { buildRunnerSequenceCommand, parseRunnerSequenceResult } from './runner-sequence.ts';
import type { RunnerCommand } from './runner-contract.ts';
import type {
  BackMode,
  Interactor,
  RunnerCallOptions,
  RunnerContext,
} from '../../core/interactor-types.ts';

export type AppleBackRunnerCommand = 'backInApp' | 'backSystem';
type AppleRemoteButton = NonNullable<RunnerCommand['remoteButton']>;
type RunIosRunnerCommand = typeof runIosRunnerCommand;
type RunnerOpts = RunnerCallOptions;

const IOS_SWIPE_DEFAULT_DURATION_MS = 250;
const IOS_SWIPE_MIN_DURATION_MS = 16;
const IOS_SWIPE_MAX_DURATION_MS = 10_000;

type NormalizedScrollOptions = {
  amount?: number;
  pixels?: number;
  durationMs?: number;
  preferProvidedPixels?: boolean;
};

type AppleScrollOptions = Omit<NormalizedScrollOptions, 'preferProvidedPixels'>;

type IosDragCommandOptions = {
  defaultDurationMs: number;
  legacyDefaultDurationMs?: number;
  synthesized?: boolean;
};

type IosRunnerOverrides = Pick<
  Interactor,
  | 'tap'
  | 'tapElementSelector'
  | 'doubleTap'
  | 'swipe'
  | 'pan'
  | 'fling'
  | 'longPress'
  | 'focus'
  | 'type'
  | 'fillElementSelector'
  | 'fill'
  | 'scroll'
  | 'pinch'
  | 'rotateGesture'
  | 'transformGesture'
>;

export function resolveAppleBackRunnerCommand(mode?: BackMode): AppleBackRunnerCommand {
  if (mode === 'system') return 'backSystem';
  return 'backInApp';
}

export function iosRunnerOverrides(
  device: DeviceInfo,
  ctx: RunnerContext,
): {
  overrides: IosRunnerOverrides;
  runnerOpts: RunnerOpts;
} {
  const runnerOpts = {
    verbose: ctx.verbose,
    logPath: ctx.logPath,
    traceLogPath: ctx.traceLogPath,
    requestId: ctx.requestId,
    iosXctestrunFile: ctx.iosXctestrunFile,
    iosXctestDerivedDataPath: ctx.iosXctestDerivedDataPath,
    iosXctestEnvDir: ctx.iosXctestEnvDir,
  };
  return {
    runnerOpts,
    overrides: {
      tap: async (x, y) => {
        return await runIosRunnerCommand(device, iosTapCommand(device, ctx, x, y), runnerOpts);
      },
      tapElementSelector: async (selector) => {
        return await runIosRunnerCommand(
          device,
          {
            command: 'tap',
            selectorKey: selector.key,
            selectorValue: selector.value,
            allowNonHittableCoordinateFallback: selector.allowNonHittableCoordinateFallback,
            appBundleId: ctx.appBundleId,
          },
          runnerOpts,
        );
      },
      doubleTap: async (x, y) => {
        // One-step `sequence` replaced the retired `tapSeries` double-tap vehicle; parsing the
        // result surfaces a failed step as an AppError instead of an ok-shaped payload.
        const runnerResult = await runIosRunnerCommand(
          device,
          buildRunnerSequenceCommand([{ kind: 'doubleTap', x, y }], ctx.appBundleId),
          runnerOpts,
        );
        parseRunnerSequenceResult(runnerResult);
        return runnerResult;
      },
      swipe: async (x1, y1, x2, y2, durationMs) => {
        return await runIosRunnerCommand(
          device,
          iosDragCommand(device, ctx, x1, y1, x2, y2, durationMs, {
            defaultDurationMs: IOS_SWIPE_DEFAULT_DURATION_MS,
            synthesized: shouldUseSynthesizedIosGesture(device),
          }),
          runnerOpts,
        );
      },
      pan: async (x1, y1, x2, y2, durationMs) => {
        return await runIosRunnerCommand(
          device,
          iosDragCommand(device, ctx, x1, y1, x2, y2, durationMs, {
            defaultDurationMs: 500,
            legacyDefaultDurationMs: 500,
            synthesized: shouldUseSynthesizedIosGesture(device),
          }),
          runnerOpts,
        );
      },
      fling: async (x1, y1, x2, y2, durationMs) => {
        return await runIosRunnerCommand(
          device,
          iosDragCommand(device, ctx, x1, y1, x2, y2, durationMs, {
            defaultDurationMs: 16,
            legacyDefaultDurationMs: 16,
            synthesized: shouldUseSynthesizedIosGesture(device),
          }),
          runnerOpts,
        );
      },
      longPress: async (x, y, durationMs) => {
        return await runIosRunnerCommand(
          device,
          { command: 'longPress', x, y, durationMs, appBundleId: ctx.appBundleId },
          runnerOpts,
        );
      },
      focus: async (x, y) => {
        return await runIosRunnerCommand(device, iosTapCommand(device, ctx, x, y), runnerOpts);
      },
      type: async (text, delayMs) => {
        await runIosRunnerCommand(
          device,
          {
            command: 'type',
            text,
            delayMs,
            textEntryMode: text === '\n' ? undefined : 'append',
            appBundleId: ctx.appBundleId,
          },
          runnerOpts,
        );
      },
      fillElementSelector: async (selector, text, delayMs) => {
        return await runIosRunnerCommand(
          device,
          {
            command: 'type',
            selectorKey: selector.key,
            selectorValue: selector.value,
            allowNonHittableCoordinateFallback: selector.allowNonHittableCoordinateFallback,
            text,
            delayMs,
            textEntryMode: 'replace',
            appBundleId: ctx.appBundleId,
          },
          runnerOpts,
        );
      },
      fill: async (x, y, text, delayMs) => {
        return await runIosRunnerCommand(
          device,
          {
            command: 'type',
            x,
            y,
            text,
            delayMs,
            textEntryMode: 'replace',
            appBundleId: ctx.appBundleId,
          },
          runnerOpts,
        );
      },
      scroll: async (direction, options) => {
        return await runAppleScroll(
          runIosRunnerCommand,
          device,
          ctx,
          runnerOpts,
          direction,
          options,
        );
      },
      pinch: async (scale, x, y) => {
        await runIosRunnerCommand(
          device,
          {
            command: 'pinch',
            scale,
            x,
            y,
            appBundleId: ctx.appBundleId,
          },
          runnerOpts,
        );
      },
      rotateGesture: async (degrees, x, y, velocity) => {
        await runIosRunnerCommand(
          device,
          {
            command: 'rotateGesture',
            degrees,
            x,
            y,
            velocity,
            appBundleId: ctx.appBundleId,
          },
          runnerOpts,
        );
      },
      transformGesture: async (options) => {
        return await runIosRunnerCommand(
          device,
          {
            command: 'transformGesture',
            x: options.x,
            y: options.y,
            dx: options.dx,
            dy: options.dy,
            scale: options.scale,
            degrees: options.degrees,
            durationMs: options.durationMs,
            appBundleId: ctx.appBundleId,
          },
          runnerOpts,
        );
      },
    },
  };
}

function iosTapCommand(
  device: DeviceInfo,
  ctx: RunnerContext,
  x: number,
  y: number,
): RunnerCommand {
  return {
    command: 'tap',
    x,
    y,
    ...(shouldUseSynthesizedIosGesture(device) ? { synthesized: true } : {}),
    appBundleId: ctx.appBundleId,
  };
}

function shouldUseSynthesizedIosGesture(device: DeviceInfo): boolean {
  return device.platform === 'ios' && device.target !== 'tv';
}

function iosDragCommand(
  device: DeviceInfo,
  ctx: RunnerContext,
  x: number,
  y: number,
  x2: number,
  y2: number,
  durationMs: number | undefined,
  options: IosDragCommandOptions,
): RunnerCommand {
  const normalizedDurationMs =
    device.platform === 'ios' && device.target !== 'tv'
      ? iosGestureDurationMs(durationMs, options.defaultDurationMs)
      : (durationMs ?? options.legacyDefaultDurationMs);
  return {
    command: 'drag',
    x,
    y,
    x2,
    y2,
    ...(normalizedDurationMs !== undefined ? { durationMs: normalizedDurationMs } : {}),
    ...(options.synthesized === true ? { synthesized: true } : {}),
    appBundleId: ctx.appBundleId,
  };
}

function iosGestureDurationMs(durationMs: number | undefined, defaultDurationMs: number): number {
  if (durationMs === undefined) return defaultDurationMs;

  return Math.min(
    IOS_SWIPE_MAX_DURATION_MS,
    Math.max(IOS_SWIPE_MIN_DURATION_MS, Math.round(durationMs)),
  );
}

export function appleRemotePressCommand(
  remoteButton: AppleRemoteButton,
  appBundleId?: string,
  durationMs?: number,
): Parameters<RunIosRunnerCommand>[1] {
  return {
    command: 'remotePress',
    remoteButton,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(appBundleId !== undefined ? { appBundleId } : {}),
  };
}

async function runAppleScroll(
  runRunnerCommand: RunIosRunnerCommand,
  device: DeviceInfo,
  ctx: RunnerContext,
  runnerOpts: RunnerOpts,
  direction: ScrollDirection,
  options?: AppleScrollOptions,
): Promise<Record<string, unknown>> {
  if (device.target === 'tv') {
    const runnerResult = await runRunnerCommand(
      device,
      appleRemotePressCommand(direction, ctx.appBundleId),
      runnerOpts,
    );
    return normalizeIosScrollResult(runnerResult, { amount: options?.amount });
  }

  // Validate amount/pixels up front so bad inputs throw INVALID_ARGS before any runner command
  // is sent (previously validation ran between the frame request and the drag, so a bad amount
  // could cost one runner request first).
  assertScrollGestureInput(options ?? {});
  assertScrollDurationInput(options?.durationMs);

  if (device.platform === 'macos') {
    const runnerResult = await runRunnerCommand(
      device,
      {
        command: 'desktopScroll',
        direction,
        ...scrollRunnerFields(options, { includeDuration: true }),
        appBundleId: ctx.appBundleId,
      },
      runnerOpts,
    );
    return normalizeScrollResultWithResolvedFrame(runnerResult, direction, options, {
      includeDuration: true,
    });
  }

  // Single fused lifecycle command: the runner resolves the interaction frame and runs the drag.
  // durationMs is intentionally not sent — scroll's drag used 250ms today, but the runner's
  // non-synthesized drag path ignores it (coordinateDragHoldDuration + XCTest default drag
  // velocity), and the fused `scroll` handler pins that same non-synthesized path.
  const runnerResult = await runRunnerCommand(
    device,
    {
      command: 'scroll',
      direction,
      ...scrollRunnerFields(options),
      appBundleId: ctx.appBundleId,
    },
    runnerOpts,
  );

  const referenceWidth = readFiniteNumber(runnerResult.referenceWidth);
  const referenceHeight = readFiniteNumber(runnerResult.referenceHeight);
  if (referenceWidth !== undefined && referenceHeight !== undefined)
    return normalizeScrollResultWithResolvedFrame(runnerResult, direction, options);

  // Missing frame dims: derive pixels from endpoint travel instead of throwing.
  return normalizeIosScrollResult(runnerResult, { amount: options?.amount });
}

function assertScrollDurationInput(durationMs: number | undefined): void {
  if (durationMs === undefined) return;
  if (
    !Number.isFinite(durationMs) ||
    !Number.isInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > SCROLL_DURATION_MAX_MS
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `scroll durationMs must be a non-negative integer at most ${SCROLL_DURATION_MAX_MS}`,
    );
  }
}

function normalizeScrollResultWithResolvedFrame(
  runnerResult: Record<string, unknown>,
  direction: ScrollDirection,
  options?: AppleScrollOptions,
  config?: { includeDuration?: boolean },
): Record<string, unknown> {
  const referenceWidth = readFiniteNumber(runnerResult.referenceWidth);
  const referenceHeight = readFiniteNumber(runnerResult.referenceHeight);
  if (referenceWidth === undefined || referenceHeight === undefined) {
    return normalizeIosScrollResult(runnerResult, { amount: options?.amount });
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
  return normalizeIosScrollResult(runnerResult, {
    amount: options?.amount,
    pixels: plan.pixels,
    durationMs: config?.includeDuration ? options?.durationMs : undefined,
    preferProvidedPixels: true,
  });
}

function scrollRunnerFields(
  options: AppleScrollOptions | undefined,
  config?: { includeDuration?: boolean },
): Record<string, number> {
  return {
    ...(options?.amount !== undefined ? { amount: options.amount } : {}),
    ...(options?.pixels !== undefined ? { pixels: options.pixels } : {}),
    ...(config?.includeDuration && options?.durationMs !== undefined
      ? { durationMs: options.durationMs }
      : {}),
  };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeIosScrollResult(
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

  const result: Record<string, unknown> = {};
  setDefinedNumber(result, 'x1', x1);
  setDefinedNumber(result, 'y1', y1);
  setDefinedNumber(result, 'x2', x2);
  setDefinedNumber(result, 'y2', y2);
  setDefinedNumber(result, 'referenceWidth', referenceWidth);
  setDefinedNumber(result, 'referenceHeight', referenceHeight);
  setDefinedNumber(result, 'amount', options?.amount);
  setDefinedNumber(result, 'pixels', travelPixels);
  setDefinedNumber(result, 'durationMs', options?.durationMs);
  return result;
}

function setDefinedNumber(
  result: Record<string, unknown>,
  key: string,
  value: number | undefined,
): void {
  if (value !== undefined) result[key] = value;
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
  return {
    x1: readFiniteNumber(runnerResult.x),
    y1: readFiniteNumber(runnerResult.y),
    x2: readFiniteNumber(runnerResult.x2),
    y2: readFiniteNumber(runnerResult.y2),
  };
}
