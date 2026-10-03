import type {
  Interactor,
  PressPointOptions,
  RunnerContext,
} from '@agent-device/contracts/interactor-types';
import { macOsHelperSurface } from '@agent-device/contracts/session';
import { assertScrollGestureInput } from '@agent-device/contracts/scroll-gesture';
import { AppError } from '@agent-device/kernel/errors';
import { normalizeAppleScrollResultWithResolvedFrame } from '../../core/scroll.ts';
import { MACOS_HELPER_REFUSAL_REASONS } from './helper.ts';

const NATIVE_APP_SURFACE = macOsHelperSurface('app', 'native')!;

/** The reason every refusal of the native backend carries, alongside the helper's own reason. */
export const MACOS_NATIVE_BACKEND_UNSUPPORTED = 'macos-native-backend-unsupported';

const NATIVE_BACKEND_HINT =
  'The native macOS app backend acts through accessibility actions only. Unset AGENT_DEVICE_MACOS_APP_BACKEND to drive this app with XCTest.';

const REFUSAL_REASONS: ReadonlySet<string> = new Set(MACOS_HELPER_REFUSAL_REASONS);

/**
 * The native app backend: every action on the session app reaches it through the macOS helper,
 * so no XCTest session starts and the app may stay behind the user's windows. Commands only the
 * runner serves refuse with a typed reason rather than starting it.
 *
 * An app session always names its app; `frontmost-app` and `desktop` sessions never do. So a call
 * that names no app, or a press on another surface, keeps the owner it has on the XCTest backend.
 * `snapshot`, `screenshot`, and `readTextAtPoint` route by surface through `macOsHelperSurface`.
 */
export function withMacOsNativeAppBackend(base: Interactor, ctx: RunnerContext): Interactor {
  const bundleId = ctx.appBundleId;
  if (!bundleId) return base;
  const press = async (
    point: { x: number; y: number },
    options: Partial<Pick<PressPointOptions, 'count' | 'intervalMs' | 'holdMs' | 'doubleTap'>> = {},
  ) => {
    const { runMacOsPressAction } = await import('./helper.ts');
    const result = await withNativeRefusals(
      runMacOsPressAction(point.x, point.y, {
        surface: NATIVE_APP_SURFACE,
        bundleId,
        holdMs: options.holdMs,
        clicks: options.count,
        doubleClick: options.doubleTap,
        intervalMs: options.intervalMs,
        signal: ctx.signal,
      }),
    );
    return { mechanism: result.mechanism };
  };
  return {
    ...base,
    tap: async (x, y) => await press({ x, y }),
    pressPoint: async (point, options) => {
      if (options.surface !== undefined && options.surface !== 'app') {
        return await base.pressPoint!(point, options);
      }
      if (options.button !== 'primary') unsupported(`${options.button} click`);
      return await press(point, options);
    },
    doubleTap: async (x, y) => await press({ x, y }, { doubleTap: true }),
    longPress: async (x, y, durationMs) => await press({ x, y }, { holdMs: durationMs ?? 800 }),
    focus: async (x, y) => await press({ x, y }),
    type: async (text, delayMs) => {
      const { runMacOsTypeAction } = await import('./helper.ts');
      await withNativeRefusals(runMacOsTypeAction(text, { bundleId, delayMs, signal: ctx.signal }));
    },
    fill: async (x, y, text) => {
      const { runMacOsFillAction } = await import('./helper.ts');
      const result = await withNativeRefusals(
        runMacOsFillAction(x, y, text, { bundleId, signal: ctx.signal }),
      );
      return { mechanism: result.mechanism };
    },
    scroll: async (direction, options) => {
      assertScrollGestureInput(options ?? {});
      const { runMacOsScrollAction } = await import('./helper.ts');
      const result = await withNativeRefusals(
        runMacOsScrollAction(direction, {
          bundleId,
          amount: options?.amount,
          pixels: options?.pixels,
          signal: ctx.signal,
        }),
      );
      return {
        ...normalizeAppleScrollResultWithResolvedFrame(result, direction, options, {
          includeDuration: false,
        }),
        mechanism: result.mechanism,
      };
    },
    back: async () => unsupported('back'),
    home: async () => unsupported('home'),
    setOrientation: async () => unsupported('orientation'),
    appSwitcher: async () => unsupported('app-switcher'),
    performGesture: async () => unsupported('gesture'),
    gestureViewport: async () => unsupported('gesture viewport'),
    keyboardDismiss: async () => unsupported('keyboard dismiss'),
    keyboardEnter: async () => unsupported('keyboard enter'),
  };
}

function unsupported(command: string): never {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `${command} is not supported by the native macOS app backend.`,
    { reason: MACOS_NATIVE_BACKEND_UNSUPPORTED, hint: NATIVE_BACKEND_HINT },
  );
}

async function withNativeRefusals<T>(action: Promise<T>): Promise<T> {
  try {
    return await action;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const reason = error.details?.reason;
    if (typeof reason !== 'string' || !REFUSAL_REASONS.has(reason)) throw error;
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      error.message,
      {
        ...error.details,
        reason: MACOS_NATIVE_BACKEND_UNSUPPORTED,
        helperReason: reason,
        hint: NATIVE_BACKEND_HINT,
      },
      error,
    );
  }
}
