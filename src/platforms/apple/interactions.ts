import { isIosFamily, isMacOs, isTvOsDevice, type DeviceInfo } from '../../kernel/device.ts';
import { assertScrollGestureInput, type ScrollDirection } from '../../contracts/scroll-gesture.ts';
import {
  normalizeScrollDurationMs,
  SCROLL_DURATION_MAX_MS,
} from '../../contracts/scroll-command.ts';
import { AppError } from '../../kernel/errors.ts';
import { singlePointerPlanEndpoints, type GesturePlan } from '../../contracts/gesture-plan.ts';
import { assertAppleMultiTouchSupported } from '../../contracts/apple-multitouch-support.ts';
import { runAppleRunnerCommand } from './core/runner/runner-client.ts';
import {
  buildRunnerSequenceCommand,
  parseRunnerSequenceResult,
} from './core/runner/runner-sequence.ts';
import type { RunnerCommand } from './core/runner/runner-contract.ts';
import { appleRemotePressCommand } from './os/tvos/remote.ts';
import { runMacosDesktopScroll } from './os/macos/desktop-scroll.ts';
import {
  normalizeAppleScrollResult,
  normalizeAppleScrollResultWithResolvedFrame,
  scrollRunnerFields,
  type AppleScrollOptions,
} from './core/scroll.ts';
import type {
  BackMode,
  Interactor,
  RunnerCallOptions,
  RunnerContext,
} from '../../core/interactor-types.ts';

export type AppleBackRunnerCommand = 'backInApp' | 'backSystem';
type RunAppleRunnerCommand = typeof runAppleRunnerCommand;
type RunnerOpts = RunnerCallOptions;

type IosRunnerOverrides = Pick<
  Interactor,
  | 'tap'
  | 'tapElementSelector'
  | 'doubleTap'
  | 'longPress'
  | 'focus'
  | 'type'
  | 'fillElementSelector'
  | 'fill'
  | 'scroll'
  | 'performGesture'
  | 'gestureViewport'
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
        return await runAppleRunnerCommand(device, iosTapCommand(device, ctx, x, y), runnerOpts);
      },
      tapElementSelector: async (selector) => {
        return await runAppleRunnerCommand(
          device,
          {
            command: 'tap',
            selectorKey: selector.key,
            selectorValue: selector.value,
            allowNonHittableCoordinateFallback: selector.allowNonHittableCoordinateFallback,
            ...(selector.expectedPoint
              ? { x: selector.expectedPoint.x, y: selector.expectedPoint.y }
              : {}),
            appBundleId: ctx.appBundleId,
          },
          runnerOpts,
        );
      },
      doubleTap: async (x, y) => {
        // One-step `sequence` replaced the retired `tapSeries` double-tap vehicle; parsing the
        // result surfaces a failed step as an AppError instead of an ok-shaped payload.
        const runnerResult = await runAppleRunnerCommand(
          device,
          buildRunnerSequenceCommand([{ kind: 'doubleTap', x, y }], ctx.appBundleId),
          runnerOpts,
        );
        parseRunnerSequenceResult(runnerResult);
        return runnerResult;
      },
      longPress: async (x, y, durationMs) => {
        return await runAppleRunnerCommand(
          device,
          { command: 'longPress', x, y, durationMs, appBundleId: ctx.appBundleId },
          runnerOpts,
        );
      },
      focus: async (x, y) => {
        return await runAppleRunnerCommand(device, iosTapCommand(device, ctx, x, y), runnerOpts);
      },
      type: async (text, delayMs) => {
        await runAppleRunnerCommand(
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
        return await runAppleRunnerCommand(
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
        return await runAppleRunnerCommand(
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
          runAppleRunnerCommand,
          device,
          ctx,
          runnerOpts,
          direction,
          options,
        );
      },
      performGesture: async (plan) => await performGestureApple(device, ctx, runnerOpts, plan),
      gestureViewport: async () => {
        const result = await runAppleRunnerCommand(
          device,
          { command: 'gestureViewport', appBundleId: ctx.appBundleId },
          runnerOpts,
        );
        return readGestureViewport(result);
      },
    },
  };
}

function readGestureViewport(result: Record<string, unknown>) {
  const x = finiteNumber(result.x);
  const y = finiteNumber(result.y);
  const width = finiteNumber(result.x2);
  const height = finiteNumber(result.y2);
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0
  ) {
    throw new AppError('COMMAND_FAILED', 'Apple runner returned an invalid gesture viewport');
  }
  return { x, y, width, height };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Executes the portable pointer plan without regenerating platform geometry. */
export async function performGestureApple(
  device: DeviceInfo,
  ctx: RunnerContext,
  runnerOpts: RunnerOpts,
  plan: GesturePlan,
): Promise<Record<string, unknown>> {
  if (plan.topology === 'two') assertAppleMultiTouchSupported(device, plan.intent);
  if (plan.topology === 'single' && isMacOs(device)) {
    const { start: first, end: last } = singlePointerPlanEndpoints(plan);
    return await runAppleRunnerCommand(
      device,
      {
        command: 'drag',
        x: first.x,
        y: first.y,
        x2: last.x,
        y2: last.y,
        durationMs: plan.durationMs,
        appBundleId: ctx.appBundleId,
      },
      runnerOpts,
    );
  }
  if (plan.topology === 'single' && isTvOsDevice(device)) {
    const { start: first, end: last } = singlePointerPlanEndpoints(plan);
    return await runAppleRunnerCommand(
      device,
      { command: 'swipe', direction: dominantDirection(first, last), appBundleId: ctx.appBundleId },
      runnerOpts,
    );
  }
  return await runAppleRunnerCommand(
    device,
    { command: 'gesture', gesturePlan: plan, appBundleId: ctx.appBundleId },
    runnerOpts,
  );
}

function dominantDirection(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ('right' as const) : ('left' as const);
  return dy >= 0 ? ('down' as const) : ('up' as const);
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
  // Two-finger HID synthesis is for touch-input iOS only; the tvOS leaf has no touch.
  return isIosFamily(device) && !isTvOsDevice(device);
}

async function runAppleScroll(
  runRunnerCommand: RunAppleRunnerCommand,
  device: DeviceInfo,
  ctx: RunnerContext,
  runnerOpts: RunnerOpts,
  direction: ScrollDirection,
  options?: AppleScrollOptions,
): Promise<Record<string, unknown>> {
  normalizeScrollDurationMs(options?.durationMs, {
    invalidMessage: `scroll durationMs must be a non-negative integer at most ${SCROLL_DURATION_MAX_MS}`,
  });

  if (isTvOsDevice(device)) {
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

  if (isMacOs(device)) {
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
