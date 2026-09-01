import {
  capturedFillUse,
  capturedHoverUse,
  capturedLongPressUse,
  capturedTapUse,
  fillPointUse,
  hoverPointUse,
  longPressPointUse,
  resolveTouchRuntimePlan,
  tapPointUse,
} from '@agent-device/contracts/platform-runtime-operations';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { PressPointOptions } from '@agent-device/contracts/interactor-types';
import { resolveClickButton } from '@agent-device/contracts/click-button';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { Point } from '@agent-device/kernel/snapshot';
import { readFillBackendResult } from '../core/fill-backend-result.ts';
import { successText } from '@agent-device/kernel/success-text';
import { requireIntInRange } from '../core/validation.ts';
import type { DaemonCommandContext } from './context.ts';
import type { DirectIosSelectorTarget } from './direct-ios-selector.ts';
import type { DaemonFailureResponse } from './response.ts';
import {
  admitRuntimeOperations,
  type RuntimeAdmissionBindings,
  type UnavailableRuntimeResponse,
} from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

export type TouchRuntimeCommand = 'click' | 'press' | 'fill' | 'longpress' | 'hover';

export type BoundTouchRuntime =
  | Readonly<{ kind: 'tap'; captured: false; runtime: BoundDeviceRuntime<typeof tapPointUse> }>
  | Readonly<{ kind: 'tap'; captured: true; runtime: BoundDeviceRuntime<typeof capturedTapUse> }>
  | Readonly<{
      kind: 'long-press';
      captured: false;
      runtime: BoundDeviceRuntime<typeof longPressPointUse>;
    }>
  | Readonly<{
      kind: 'long-press';
      captured: true;
      runtime: BoundDeviceRuntime<typeof capturedLongPressUse>;
    }>
  | Readonly<{ kind: 'hover'; captured: false; runtime: BoundDeviceRuntime<typeof hoverPointUse> }>
  | Readonly<{
      kind: 'hover';
      captured: true;
      runtime: BoundDeviceRuntime<typeof capturedHoverUse>;
    }>
  | Readonly<{ kind: 'fill'; captured: false; runtime: BoundDeviceRuntime<typeof fillPointUse> }>
  | Readonly<{
      kind: 'fill';
      captured: true;
      runtime: BoundDeviceRuntime<typeof capturedFillUse>;
    }>;

type CapturedTouchRuntime =
  | BoundDeviceRuntime<typeof capturedTapUse>
  | BoundDeviceRuntime<typeof capturedLongPressUse>
  | BoundDeviceRuntime<typeof capturedHoverUse>
  | BoundDeviceRuntime<typeof capturedFillUse>;

export type ResolvedTouchRuntime =
  | Readonly<{ ok: false; response: DaemonFailureResponse }>
  | Readonly<{ ok: true; runtime: BoundTouchRuntime }>;

export async function resolveBoundTouchRuntime(
  params: {
    device: DeviceInfo;
    command: TouchRuntimeCommand;
    requiresCapture: boolean;
    /** A caller whose command is not the touch leaf itself supplies its own refusal wording. */
    unavailableResponse?: UnavailableRuntimeResponse;
  } & RuntimeAdmissionBindings,
): Promise<ResolvedTouchRuntime> {
  const shared = {
    device: params.device,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  };
  const plan = resolveTouchRuntimePlan(params.command, params.requiresCapture);
  const admission = await admitRuntimeOperations({
    command: params.command,
    required: plan.use.required,
    ...(params.unavailableResponse ? { unavailableResponse: params.unavailableResponse } : {}),
    ...shared,
  });
  if (admission.type === 'response') return { ok: false, response: admission.response };
  const bind = admission.bind;
  // Only the exact bind differs per plan, so every arm retains its required-operation projection.
  switch (plan.kind) {
    case 'tap-point':
      return {
        ok: true,
        runtime: { kind: 'tap', captured: false, runtime: await bind(params.device, tapPointUse) },
      };
    case 'captured-tap':
      return {
        ok: true,
        runtime: {
          kind: 'tap',
          captured: true,
          runtime: await bind(params.device, capturedTapUse),
        },
      };
    case 'long-press-point':
      return {
        ok: true,
        runtime: {
          kind: 'long-press',
          captured: false,
          runtime: await bind(params.device, longPressPointUse),
        },
      };
    case 'captured-long-press':
      return {
        ok: true,
        runtime: {
          kind: 'long-press',
          captured: true,
          runtime: await bind(params.device, capturedLongPressUse),
        },
      };
    case 'hover-point':
      return {
        ok: true,
        runtime: {
          kind: 'hover',
          captured: false,
          runtime: await bind(params.device, hoverPointUse),
        },
      };
    case 'captured-hover':
      return {
        ok: true,
        runtime: {
          kind: 'hover',
          captured: true,
          runtime: await bind(params.device, capturedHoverUse),
        },
      };
    case 'fill-point':
      return {
        ok: true,
        runtime: {
          kind: 'fill',
          captured: false,
          runtime: await bind(params.device, fillPointUse),
        },
      };
    case 'captured-fill':
      return {
        ok: true,
        runtime: {
          kind: 'fill',
          captured: true,
          runtime: await bind(params.device, capturedFillUse),
        },
      };
  }
}

export type BoundTouchExecutor = Readonly<{
  captureSnapshot?: (input: CaptureSnapshotInput) => Promise<SnapshotResult>;
  tapPoint?: (
    point: Point,
    options?: Partial<PressPointOptions>,
  ) => Promise<Record<string, unknown>>;
  tapRef?: (ref: string) => Promise<Record<string, unknown> | void>;
  longPressPoint?: (point: Point, durationMs?: number) => Promise<Record<string, unknown>>;
  hoverPoint?: (point: Point) => Promise<Record<string, unknown>>;
  hoverRef?: (ref: string) => Promise<Record<string, unknown> | void>;
  fillPoint?: (
    point: Point,
    text: string,
    options?: { delayMs?: number; allowNonHittableCoordinateFallback?: boolean },
  ) => Promise<Record<string, unknown>>;
  fillRef?: (
    ref: string,
    text: string,
    options?: { delayMs?: number },
  ) => Promise<Record<string, unknown> | void>;
  tapElementSelector?: (selector: DirectIosSelectorTarget) => Promise<Record<string, unknown>>;
}>;

export function createBoundTouchExecutor(
  bound: BoundTouchRuntime,
  context: DaemonCommandContext,
): BoundTouchExecutor {
  const shared = {
    execution: runtimeExecutionFromContext(context),
    appBundleId: context.appBundleId,
  };
  const captureSnapshot = bound.captured ? readCaptureSnapshot(bound.runtime) : undefined;
  switch (bound.kind) {
    case 'tap':
      return createTapTouchExecutor(bound, context, shared, captureSnapshot);
    case 'long-press':
      return createLongPressTouchExecutor(bound, shared, captureSnapshot);
    case 'hover':
      return createHoverTouchExecutor(bound, shared, captureSnapshot);
    case 'fill':
      return createFillTouchExecutor(bound, context, shared, captureSnapshot);
  }
}

type TouchSharedInput = Readonly<{
  execution: ReturnType<typeof runtimeExecutionFromContext>;
  appBundleId: string | undefined;
}>;

function createTapTouchExecutor(
  bound: Extract<BoundTouchRuntime, { kind: 'tap' }>,
  context: DaemonCommandContext,
  shared: TouchSharedInput,
  captureSnapshot: BoundTouchExecutor['captureSnapshot'],
): BoundTouchExecutor {
  const tapRef = bound.captured ? bound.runtime.operations.tapRef : undefined;
  const tapElementSelector = bound.captured
    ? bound.runtime.operations.tapElementSelector
    : undefined;
  return Object.freeze({
    captureSnapshot,
    tapPoint: async (point: Point, options: Partial<PressPointOptions> = {}) => {
      const normalized = normalizePressOptions(options, context);
      const result = await bound.runtime.operations.tapPoint({
        point,
        options: normalized,
        ...shared,
      });
      return {
        x: point.x,
        y: point.y,
        count: normalized.count,
        intervalMs: normalized.intervalMs,
        holdMs: normalized.holdMs,
        jitterPx: normalized.jitterPx,
        doubleTap: normalized.doubleTap,
        ...(normalized.button === 'primary' ? {} : { button: normalized.button }),
        ...(result ?? {}),
        ...successText(formatPressMessage(point, normalized.button)),
      };
    },
    tapRef: tapRef ? async (ref) => await tapRef({ ref, ...shared }) : undefined,
    tapElementSelector:
      bound.captured && tapElementSelector
        ? async (selector) => {
            const result = await bound.runtime.operations.tapElementSelector?.({
              selector,
              ...shared,
            });
            const usedFallback = result?.maestroNonHittableCoordinateFallbackUsed === true;
            return {
              selector: selector.raw,
              ...(result ?? {}),
              ...successText(
                usedFallback
                  ? 'tapped via non-hittable coordinate fallback'
                  : `Tapped ${selector.raw}`,
              ),
            };
          }
        : undefined,
  });
}

function createLongPressTouchExecutor(
  bound: Extract<BoundTouchRuntime, { kind: 'long-press' }>,
  shared: TouchSharedInput,
  captureSnapshot: BoundTouchExecutor['captureSnapshot'],
): BoundTouchExecutor {
  return Object.freeze({
    captureSnapshot,
    longPressPoint: async (point, durationMs) => {
      const result = await bound.runtime.operations.longPressPoint({
        point,
        durationMs,
        ...shared,
      });
      return {
        x: point.x,
        y: point.y,
        durationMs,
        ...(result ?? {}),
        ...successText(`Long pressed (${point.x}, ${point.y})`),
      };
    },
  });
}

function createHoverTouchExecutor(
  bound: Extract<BoundTouchRuntime, { kind: 'hover' }>,
  shared: TouchSharedInput,
  captureSnapshot: BoundTouchExecutor['captureSnapshot'],
): BoundTouchExecutor {
  const hoverRef = bound.captured ? bound.runtime.operations.hoverRef : undefined;
  return Object.freeze({
    captureSnapshot,
    hoverPoint: async (point) => {
      const result = await bound.runtime.operations.hoverPoint({ point, ...shared });
      return {
        x: point.x,
        y: point.y,
        ...(result ?? {}),
        ...successText(`Hovered (${point.x}, ${point.y})`),
      };
    },
    hoverRef: hoverRef ? async (ref) => await hoverRef({ ref, ...shared }) : undefined,
  });
}

function createFillTouchExecutor(
  bound: Extract<BoundTouchRuntime, { kind: 'fill' }>,
  context: DaemonCommandContext,
  shared: TouchSharedInput,
  captureSnapshot: BoundTouchExecutor['captureSnapshot'],
): BoundTouchExecutor {
  const fillRef = bound.captured ? bound.runtime.operations.fillRef : undefined;
  const delay = (value: number | undefined) =>
    requireIntInRange(value ?? context.delayMs ?? 0, 'delay-ms', 0, 10_000);
  return Object.freeze({
    captureSnapshot,
    fillPoint: async (point, text, options = {}) => {
      const delayMs = delay(options.delayMs);
      const result = await bound.runtime.operations.fillPoint({
        point,
        text,
        delayMs,
        allowNonHittableCoordinateFallback: options.allowNonHittableCoordinateFallback === true,
        ...shared,
      });
      return {
        x: point.x,
        y: point.y,
        text,
        delayMs,
        ...(usedMaestroCoordinateFallback(result)
          ? { maestroNonHittableCoordinateFallbackUsed: true }
          : {}),
        ...readFillBackendResult(result),
        ...successText(`Filled ${Array.from(text).length} chars`),
      };
    },
    fillRef: fillRef
      ? async (ref, text, options = {}) =>
          await fillRef({ ref, text, delayMs: delay(options.delayMs), ...shared })
      : undefined,
  });
}

function usedMaestroCoordinateFallback(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === 'object' &&
    'maestroNonHittableCoordinateFallbackUsed' in result &&
    result.maestroNonHittableCoordinateFallbackUsed === true
  );
}

function readCaptureSnapshot(runtime: CapturedTouchRuntime) {
  return async (input: CaptureSnapshotInput) => await runtime.operations.captureSnapshot(input);
}

function normalizePressOptions(
  options: Partial<PressPointOptions>,
  context: DaemonCommandContext,
): PressPointOptions {
  const series = normalizePressSeries(options, context);
  validatePressSeries(series);
  return {
    button: options.button ?? resolveClickButton(context),
    ...series,
    surface: options.surface ?? context.surface,
  };
}

function normalizePressSeries(options: Partial<PressPointOptions>, context: DaemonCommandContext) {
  const count = pressSeriesInt(options.count, context.count, 1, 'count', 1, 200);
  const intervalMs = pressSeriesInt(
    options.intervalMs,
    context.intervalMs,
    0,
    'interval-ms',
    0,
    10_000,
  );
  const holdMs = pressSeriesInt(options.holdMs, context.holdMs, 0, 'hold-ms', 0, 10_000);
  const jitterPx = pressSeriesInt(options.jitterPx, context.jitterPx, 0, 'jitter-px', 0, 100);
  const doubleTap = options.doubleTap ?? context.doubleTap ?? false;
  return { count, intervalMs, holdMs, jitterPx, doubleTap };
}

function pressSeriesInt(
  option: number | undefined,
  context: number | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  return requireIntInRange(option ?? context ?? fallback, name, min, max);
}

function validatePressSeries(series: ReturnType<typeof normalizePressSeries>): void {
  if (series.doubleTap && series.holdMs > 0) {
    throw new AppError('INVALID_ARGS', 'double-tap cannot be combined with hold-ms');
  }
  if (series.doubleTap && series.jitterPx > 0) {
    throw new AppError('INVALID_ARGS', 'double-tap cannot be combined with jitter-px');
  }
}

function formatPressMessage(point: Point, button: PressPointOptions['button']): string {
  return button === 'primary'
    ? `Pressed (${point.x}, ${point.y})`
    : `${button === 'secondary' ? 'Right' : 'Middle'} clicked (${point.x}, ${point.y})`;
}
