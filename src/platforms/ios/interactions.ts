import type { DeviceInfo } from '../../kernel/device.ts';
import { assertScrollGestureInput, type ScrollDirection } from '../../core/scroll-gesture.ts';
import { normalizeScrollDurationMs, SCROLL_DURATION_MAX_MS } from '../../core/scroll-command.ts';
import { runIosRunnerCommand } from './runner-client.ts';
import { buildRunnerSequenceCommand, parseRunnerSequenceResult } from './runner-sequence.ts';
import type { RunnerCommand } from './runner-contract.ts';
import { runMacosDesktopScroll } from './desktop-scroll.ts';
import {
  normalizeAppleScrollResult,
  normalizeAppleScrollResultWithResolvedFrame,
  scrollRunnerFields,
  type AppleScrollOptions,
} from './scroll.ts';
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
    runnerLeaseContext: ctx.runnerLeaseContext,
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
  normalizeScrollDurationMs(options?.durationMs, {
    invalidMessage: `scroll durationMs must be a non-negative integer at most ${SCROLL_DURATION_MAX_MS}`,
  });

  if (device.target === 'tv') {
    const runnerResult = await runRunnerCommand(
      device,
      appleRemotePressCommand(direction, ctx.appBundleId, options?.durationMs),
      runnerOpts,
    );
    return normalizeAppleScrollResult(runnerResult, {
      amount: options?.amount,
      durationMs: options?.durationMs,
    });
  }

  // Validate amount/pixels up front so bad inputs throw INVALID_ARGS before any runner command
  // is sent (previously validation ran between the frame request and the drag, so a bad amount
  // could cost one runner request first).
  assertScrollGestureInput(options ?? {});

  if (device.platform === 'macos') {
    return await runMacosDesktopScroll(
      runRunnerCommand,
      device,
      ctx,
      runnerOpts,
      direction,
      options,
    );
  }

  // Single fused lifecycle command: the runner resolves the interaction frame and runs the drag.
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

  return normalizeAppleScrollResultWithResolvedFrame(runnerResult, direction, options);
}
