import type {
  Interactor,
  PressPointOptions,
  RunnerContext,
} from '@agent-device/contracts/interactor-types';
import type { MacOsNativeAppActions } from '@agent-device/contracts/macos-platform-leaf';
import { macOsHelperSurface } from '@agent-device/contracts/session';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  assertScrollGestureInput,
  normalizeAppleScrollResultWithResolvedFrame,
} from '@agent-device/contracts/scroll-gesture';
import type { MacOsToolbox } from './toolbox.ts';
import {
  MACOS_HELPER_REFUSAL_REASONS,
  runMacOsFillAction,
  runMacOsPressAction,
  runMacOsScrollAction,
  runMacOsShowMenuAction,
  runMacOsTypeAction,
} from './helper.ts';

const NATIVE_APP_SURFACE = macOsHelperSurface('app', 'native')!;

const NATIVE_BACKEND_HINT =
  'The native macOS app backend acts through accessibility actions only. Unset AGENT_DEVICE_MACOS_APP_BACKEND to drive this app with XCTest.';

/**
 * The actions of the native backend on the session app. Each goes through the macOS helper, so
 * nothing here reaches the XCTest runner. The Apple owner assembles the session interactor from
 * these and from its own members whose macOS implementation uses local tooling or the helper.
 * Runner-only commands are refused at admission by `MACOS_NATIVE_BACKEND_FACTS`; the members the
 * interface requires for them refuse the same way.
 */
export function macOsNativeAppActions(
  box: MacOsToolbox,
  base: Pick<Interactor, 'pressPoint'>,
  ctx: RunnerContext,
  env: Readonly<EnvMap>,
): MacOsNativeAppActions {
  const bundleId = (): string => {
    if (ctx.appBundleId) return ctx.appBundleId;
    throw nativeBackendRefusal('an action on a session that names no app');
  };
  const press = async (
    point: { x: number; y: number },
    options: Partial<Pick<PressPointOptions, 'count' | 'intervalMs'>> = {},
  ) => {
    const result = await withHelperRefusals(
      runMacOsPressAction(box, point.x, point.y, {
        surface: NATIVE_APP_SURFACE,
        bundleId: bundleId(),
        clicks: options.count,
        intervalMs: options.intervalMs,
        signal: ctx.signal,
        env,
      }),
    );
    return actedOn(result);
  };
  return {
    tap: async (x, y) => await press({ x, y }),
    pressPoint: async (point, options) => {
      // Another surface's press is the helper's own surface press, never the runner's.
      if (options.surface !== undefined && options.surface !== 'app') {
        return await base.pressPoint!(point, options);
      }
      if (options.button === 'secondary') {
        const result = await withHelperRefusals(
          runMacOsShowMenuAction(box, point.x, point.y, {
            bundleId: bundleId(),
            signal: ctx.signal,
            env,
          }),
        );
        return actedOn(result);
      }
      if (options.button !== 'primary') throw nativeBackendRefusal(`${options.button} click`);
      if (options.doubleTap) throw nativeBackendRefusal('double-click');
      if (options.holdMs > 0) throw nativeBackendRefusal('press and hold');
      return await press(point, options);
    },
    longPress: async () => {
      throw nativeBackendRefusal('press and hold');
    },
    focus: async (x, y) => await press({ x, y }),
    type: async (text, delayMs) => {
      await withHelperRefusals(
        runMacOsTypeAction(box, text, { bundleId: bundleId(), delayMs, signal: ctx.signal, env }),
      );
    },
    fill: async (x, y, text) => {
      const result = await withHelperRefusals(
        runMacOsFillAction(box, x, y, text, { bundleId: bundleId(), signal: ctx.signal, env }),
      );
      return actedOn(result);
    },
    scroll: async (direction, options) => {
      assertScrollGestureInput(options ?? {});
      const result = await withHelperRefusals(
        runMacOsScrollAction(box, direction, {
          bundleId: bundleId(),
          amount: options?.amount,
          pixels: options?.pixels,
          signal: ctx.signal,
          env,
        }),
      );
      return {
        ...normalizeAppleScrollResultWithResolvedFrame(result, direction, options, {
          includeDuration: false,
        }),
        mechanism: result.mechanism,
      };
    },
    back: async () => {
      throw nativeBackendRefusal('back');
    },
    setOrientation: async () => {
      throw nativeBackendRefusal('orientation');
    },
  };
}

/** What the helper reports about the element it acted on. */
function actedOn(result: { mechanism?: string; windowTitle?: string }) {
  return {
    mechanism: result.mechanism,
    ...(result.windowTitle === undefined ? {} : { windowTitle: result.windowTitle }),
  };
}

function nativeBackendRefusal(action: string): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `${action} is not supported by the native macOS app backend.`,
    { reason: 'unsupported-device-backend', hint: NATIVE_BACKEND_HINT },
  );
}

async function withHelperRefusals<T>(action: Promise<T>): Promise<T> {
  try {
    return await action;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const reason = error.details?.reason;
    if (typeof reason !== 'string' || !MACOS_HELPER_REFUSAL_REASONS.has(reason)) throw error;
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      error.message,
      {
        ...error.details,
        reason: 'unsupported-device-backend',
        helperReason: reason,
        hint: NATIVE_BACKEND_HINT,
      },
      error,
    );
  }
}
