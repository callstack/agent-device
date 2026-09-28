import { openIosApp, closeIosApp, openIosDevice } from '../core/app-launch.ts';
import { captureSimulatorScreenshotWithRetry } from '../core/screenshot.ts';
import { ensureBootedSimulator } from '../core/simulator.ts';
import { runAppleToolCommand } from '../core/tool-provider.ts';
import { runSimctlForDevice } from '../core/simctl.ts';
import { ensureWatchHelperBinary } from './watch-helper-cache.ts';
import { hasWatchSimulatorHidDisplay } from './hid.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { ScrollExecutionOptions } from '@agent-device/contracts/scroll-command';
import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import { singlePointerPlanEndpoints } from '@agent-device/contracts/gesture-plan';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';

const watchViewportCache = new Map<
  string,
  Readonly<{ x: 0; y: 0; width: number; height: number }>
>();

export function createWatchOsInteractor(device: DeviceInfo, context: RunnerContext): Interactor {
  if (device.kind !== 'simulator') {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      'watchOS interaction is supported only on Simulator targets.',
    );
  }
  if (device.simulatorSetPath) {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      'watchOS interaction supports only the default Simulator device set.',
    );
  }
  return {
    open: (app, options) =>
      openIosApp(device, app, {
        appBundleId: options?.appBundleId,
        launchArgs: options?.launchArgs,
        terminateRunningApp: options?.terminateRunningApp,
        url: options?.url,
      }),
    openDevice: () => openIosDevice(device),
    close: (app) => closeIosApp(device, app),
    tap: async (x, y) =>
      await runWatchHelper(device, context, ['tap', ...(await pointArgs(device, context, x, y))]),
    pressPoint: async (point, options) => {
      if (options.button !== 'primary') {
        throw new AppError('UNSUPPORTED_OPERATION', 'watchOS supports primary touch only.');
      }
      if (options.count !== 1 || options.doubleTap || options.jitterPx !== 0) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'watchOS does not support touch series, jitter, or fused double taps.',
        );
      }
      if (options.holdMs > 0) {
        return await runWatchSwipe(
          device,
          context,
          point.x,
          point.y,
          point.x,
          point.y,
          options.holdMs,
        );
      }
      return await runWatchHelper(device, context, [
        'tap',
        ...(await pointArgs(device, context, point.x, point.y)),
      ]);
    },
    longPress: async (x, y, durationMs = 750) =>
      await runWatchSwipe(device, context, x, y, x, y, durationMs),
    focus: async (x, y) =>
      await runWatchHelper(device, context, ['tap', ...(await pointArgs(device, context, x, y))]),
    type: async () => unsupported('Text entry is not supported by the watchOS HID backend.'),
    fill: async () => unsupported('Text entry is not supported by the watchOS HID backend.'),
    scroll: async (direction, options) => await scrollWatch(device, context, direction, options),
    screenshot: async (outPath, options) => {
      if (options?.pixelDensity !== undefined) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'watchOS Simulator screenshots do not support pixel-density normalization.',
        );
      }
      await ensureBootedSimulator(device);
      await captureSimulatorScreenshotWithRetry(device, outPath);
    },
    snapshot: async () =>
      unsupported('watchOS snapshots are served by the isolated Simulator accessibility bridge.'),
    gestureViewport: async () => await watchViewport(device, context),
    performGesture: async (plan) => await performWatchGesture(device, context, plan),
    back: async () => {
      await runWatchHelper(device, context, ['crown-press']);
    },
    home: async () => {
      await runWatchHelper(device, context, ['crown-press']);
    },
    setOrientation: async () => unsupported('watchOS has a fixed display orientation.'),
    setSetting: async () => unsupported('watchOS settings are not supported by this backend.'),
  };
}

async function performWatchGesture(
  device: DeviceInfo,
  context: RunnerContext,
  plan: GesturePlan,
): Promise<Record<string, unknown>> {
  if (plan.topology !== 'single') {
    return unsupported('watchOS supports only single-contact gestures.');
  }
  const { start, end } = singlePointerPlanEndpoints(plan);
  return await runWatchSwipe(device, context, start.x, start.y, end.x, end.y, plan.durationMs);
}

async function scrollWatch(
  device: DeviceInfo,
  context: RunnerContext,
  direction: ScrollDirection,
  options?: ScrollExecutionOptions,
): Promise<Record<string, unknown>> {
  if (direction === 'left' || direction === 'right') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'watchOS Digital Crown scrolling is vertical only.',
    );
  }
  if (options?.pixels !== undefined || options?.durationMs !== undefined) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'watchOS Digital Crown scrolling supports amount only; pixels and duration are not mapped.',
    );
  }
  const amount = options?.amount ?? 0.5;
  const delta = (direction === 'down' ? 1 : -1) * amount * 360;
  return await runWatchHelper(device, context, ['crown-scroll', String(delta)]);
}

async function runWatchSwipe(
  device: DeviceInfo,
  context: RunnerContext,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): Promise<Record<string, unknown>> {
  return await runWatchHelper(device, context, [
    'swipe',
    ...(await pointArgs(device, context, x1, y1)),
    ...(await pointArgs(device, context, x2, y2)),
    String(Math.max(50, Math.min(5_000, Math.round(durationMs)))),
  ]);
}

async function pointArgs(
  device: DeviceInfo,
  context: RunnerContext,
  x: number,
  y: number,
): Promise<[string, string]> {
  const viewport = await watchViewport(device, context);
  if (
    ![x, y].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    x > viewport.width ||
    y > viewport.height
  ) {
    throw new AppError('INVALID_ARGS', 'watchOS point is outside the selected display viewport.', {
      point: { x, y },
      viewport,
    });
  }
  return [String(x / viewport.width), String(y / viewport.height)];
}

async function watchViewport(
  device: DeviceInfo,
  context: RunnerContext,
): Promise<Readonly<{ x: 0; y: 0; width: number; height: number }>> {
  await ensureBootedSimulator(device);
  const cached = watchViewportCache.get(device.id);
  if (cached) return cached;
  const result = await runSimctlForDevice(device, ['io', device.id, 'enumerate'], {
    signal: context.signal,
    allowFailure: true,
    timeoutMs: 10_000,
  });
  if (!hasWatchSimulatorHidDisplay(result)) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'The selected Xcode/watchOS runtime does not expose a compatible Simulator HID display.',
      {
        reason: 'watchos-simulator-hid-unavailable',
        deviceId: device.id,
        exitCode: result.exitCode,
      },
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const width = Number(/Default width:\s*(\d+)/.exec(output)?.[1]);
  const height = Number(/Default height:\s*(\d+)/.exec(output)?.[1]);
  const scale = Number(/Preferred UI Scale:\s*([\d.]+)/.exec(output)?.[1]);
  const viewport = Object.freeze({
    x: 0 as const,
    y: 0 as const,
    width: width / scale,
    height: height / scale,
  });
  watchViewportCache.set(device.id, viewport);
  return viewport;
}

async function runWatchHelper(
  device: DeviceInfo,
  context: RunnerContext,
  args: string[],
): Promise<Record<string, unknown>> {
  context.signal?.throwIfAborted();
  await ensureBootedSimulator(device);
  const helper = await ensureWatchHelperBinary({ signal: context.signal });
  const result = await runAppleToolCommand(helper.path, [device.id, ...args], {
    signal: context.signal,
    allowFailure: true,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'watchOS Simulator control failed.', {
      reason: 'watch-helper-command-failed',
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 2_048),
    });
  }
  return { backend: 'watchos-coresimulator' };
}

function unsupported(message: string): never {
  throw new AppError('UNSUPPORTED_OPERATION', message);
}
