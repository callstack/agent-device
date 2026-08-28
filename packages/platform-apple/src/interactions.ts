import type { BackMode } from '@agent-device/contracts/back-mode';
import { singlePointerPlanEndpoints } from '@agent-device/contracts/gesture-plan';
import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import {
  type Interactor,
  type PressPointOptions,
  type RunnerCallOptions,
  type RunnerContext,
  TEXT_ENTRY_ROUTES,
  type TextEntryRoute,
  type TypeTextBackendResult,
} from '@agent-device/contracts/interactor-types';
import {
  SCROLL_DURATION_MAX_MS,
  normalizeScrollDurationMs,
} from '@agent-device/contracts/scroll-command';
import {
  type ScrollDirection,
  assertScrollGestureInput,
} from '@agent-device/contracts/scroll-gesture';
import { assertAppleMultiTouchSupported } from '@agent-device/contracts/apple-multitouch-support';
import { isIosFamily, isMacOs, isTvOsDevice, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runAppleRunnerCommand, runApplePressSeries } from './core/runner-client.ts';
import {
  buildRunnerSequenceCommand,
  parseRunnerSequenceResult,
  type RunnerCommand,
} from './runner/index.ts';
import {
  materializeIosScrollOptions,
  normalizeAppleScrollResult,
  normalizeAppleScrollResultWithResolvedFrame,
  scrollRunnerFields,
  type AppleScrollOptions,
} from './core/scroll.ts';
import { runMacosDesktopScroll } from './os/macos/desktop-scroll.ts';
import { appleRemotePressCommand } from './os/tvos/remote.ts';

export type AppleBackRunnerCommand = 'backInApp' | 'backSystem';
type RunAppleRunnerCommand = typeof runAppleRunnerCommand;
type RunnerOpts = RunnerCallOptions;

type IosRunnerOverrides = Pick<
  Interactor,
  | 'tap'
  | 'pressPoint'
  | 'tapElementSelector'
  | 'doubleTap'
  | 'longPress'
  | 'focus'
  | 'type'
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
    signal: ctx.signal,
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
      pressPoint: async (point, options) =>
        await runApplePressPoint(device, ctx, runnerOpts, point, options),
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
            ...(shouldUseSynthesizedIosGesture(device) ? { synthesized: true } : {}),
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
        return readTypeTextBackendResult(
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
          ),
        );
      },
      fill: async (x, y, text, delayMs, options) => {
        return await runAppleRunnerCommand(
          device,
          {
            command: 'type',
            x,
            y,
            text,
            delayMs,
            textEntryMode: 'replace',
            ...(options?.allowNonHittableCoordinateFallback
              ? { allowNonHittableCoordinateFallback: true }
              : {}),
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

async function runApplePressPoint(
  device: DeviceInfo,
  context: RunnerContext,
  runnerOpts: RunnerOpts,
  point: { x: number; y: number },
  options: PressPointOptions,
): Promise<Record<string, unknown>> {
  if (isMacOs(device) && options.surface && options.surface !== 'app') {
    return await runMacOsSurfacePress(context, point, options);
  }
  if (options.button !== 'primary') {
    return await runAppleAlternateClick(device, context, runnerOpts, point, options.button);
  }
  if (options.count === 1) {
    return await runSingleApplePress(device, context, runnerOpts, point, options);
  }
  return await runApplePressSeries(
    device,
    point,
    options,
    context.appBundleId,
    async (command) => await runAppleRunnerCommand(device, command, runnerOpts),
  );
}

async function runMacOsSurfacePress(
  context: RunnerContext,
  point: { x: number; y: number },
  options: PressPointOptions,
): Promise<Record<string, unknown>> {
  if (options.button !== 'primary') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `${options.button} click is not supported on macOS ${options.surface} sessions.`,
    );
  }
  const { runMacOsPressAction } = await import('./os/macos/helper.ts');
  await runMacOsPressAction(point.x, point.y, {
    bundleId: context.appBundleId,
    surface: options.surface,
  });
  return {};
}

async function runAppleAlternateClick(
  device: DeviceInfo,
  context: RunnerContext,
  runnerOpts: RunnerOpts,
  point: { x: number; y: number },
  button: 'secondary' | 'middle',
) {
  return await runAppleRunnerCommand(
    device,
    {
      command: 'mouseClick',
      x: point.x,
      y: point.y,
      button,
      appBundleId: context.appBundleId,
    },
    runnerOpts,
  );
}

async function runSingleApplePress(
  device: DeviceInfo,
  context: RunnerContext,
  runnerOpts: RunnerOpts,
  point: { x: number; y: number },
  options: PressPointOptions,
) {
  if (options.doubleTap) {
    const result = await runAppleRunnerCommand(
      device,
      buildRunnerSequenceCommand(
        [{ kind: 'doubleTap', x: point.x, y: point.y }],
        context.appBundleId,
      ),
      runnerOpts,
    );
    parseRunnerSequenceResult(result);
    return result;
  }
  if (options.holdMs > 0) {
    return await runAppleRunnerCommand(
      device,
      {
        command: 'longPress',
        x: point.x,
        y: point.y,
        durationMs: options.holdMs,
        appBundleId: context.appBundleId,
      },
      runnerOpts,
    );
  }
  return await runAppleRunnerCommand(
    device,
    iosTapCommand(device, context, point.x, point.y),
    runnerOpts,
  );
}

/**
 * The runner wire payload is untrusted JSON; this is the one place a `type`
 * response becomes the typed {@link TypeTextBackendResult} its only consumer
 * (the bound type-text runtime operation) reads.
 */
function readTypeTextBackendResult(result: Record<string, unknown>): TypeTextBackendResult {
  const route = result.textEntryRoute;
  return isTextEntryRoute(route) ? { textEntryRoute: route } : {};
}

function isTextEntryRoute(value: unknown): value is TextEntryRoute {
  return typeof value === 'string' && (TEXT_ENTRY_ROUTES as readonly string[]).includes(value);
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

  const iosOptions = materializeIosScrollOptions(options);

  // Single fused lifecycle command: the runner resolves the interaction frame and runs the drag.
  const runnerResult = await runRunnerCommand(
    device,
    {
      command: 'scroll',
      direction,
      ...scrollRunnerFields(iosOptions),
      appBundleId: ctx.appBundleId,
    },
    runnerOpts,
  );

  return normalizeAppleScrollResultWithResolvedFrame(runnerResult, direction, iosOptions);
}
