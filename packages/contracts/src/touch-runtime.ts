import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { Point } from '@agent-device/kernel/snapshot';
import {
  localInteractorSource,
  providerInteractorSource,
  type LocalInteractorOperationResolver,
  type ProviderInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import type {
  ElementSelectorTapOptions,
  FillBackendResult,
  Interactor,
  PressPointOptions,
  RunnerContext,
} from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

type TouchExecutionInput = Readonly<{
  execution?: SnapshotRuntimeExecution;
  appBundleId?: string;
}>;

export type TapPointInput = TouchExecutionInput &
  Readonly<{
    point: Point;
    options: PressPointOptions;
  }>;

export type TapRefInput = TouchExecutionInput & Readonly<{ ref: string }>;

export type LongPressPointInput = TouchExecutionInput &
  Readonly<{ point: Point; durationMs?: number }>;

export type HoverPointInput = TouchExecutionInput & Readonly<{ point: Point }>;
export type HoverRefInput = TouchExecutionInput & Readonly<{ ref: string }>;

export type FillPointInput = TouchExecutionInput &
  Readonly<{
    point: Point;
    text: string;
    delayMs: number;
    allowNonHittableCoordinateFallback: boolean;
  }>;
export type FillRefInput = TouchExecutionInput &
  Readonly<{ ref: string; text: string; delayMs: number }>;

export type TapElementSelectorInput = TouchExecutionInput &
  Readonly<{ selector: ElementSelectorTapOptions }>;

export type TouchRuntimeOperations = Readonly<{
  tapPoint(input: TapPointInput): Promise<Record<string, unknown> | void>;
  tapRef(input: TapRefInput): Promise<Record<string, unknown> | void>;
  longPressPoint(input: LongPressPointInput): Promise<Record<string, unknown> | void>;
  hoverPoint(input: HoverPointInput): Promise<Record<string, unknown> | void>;
  hoverRef(input: HoverRefInput): Promise<Record<string, unknown> | void>;
  fillPoint(input: FillPointInput): Promise<FillBackendResult | Record<string, unknown> | void>;
  fillRef(input: FillRefInput): Promise<FillBackendResult | Record<string, unknown> | void>;
  tapElementSelector(input: TapElementSelectorInput): Promise<Record<string, unknown> | void>;
}>;

export type TouchRuntimeOperationFacts = Readonly<{
  tapPoint: RuntimeOperationFact;
  tapRef: RuntimeOperationFact;
  longPressPoint: RuntimeOperationFact;
  hoverPoint: RuntimeOperationFact;
  hoverRef: RuntimeOperationFact;
  fillPoint: RuntimeOperationFact;
  fillRef: RuntimeOperationFact;
  tapElementSelector: RuntimeOperationFact;
}>;

export const HOVER_UNAVAILABLE_HINT =
  'hover raises pointer hover state and is available on web targets only. On touch platforms use longpress for hold gestures.';

export function touchRuntimeOperationFacts(
  input: Readonly<{
    tap: RuntimeOperationFact;
    tapRef?: RuntimeOperationFact;
    longPress: RuntimeOperationFact;
    hover: RuntimeOperationFact;
    hoverRef?: RuntimeOperationFact;
    fill: RuntimeOperationFact;
    fillRef?: RuntimeOperationFact;
    tapElementSelector: RuntimeOperationFact;
  }>,
): TouchRuntimeOperationFacts {
  const hoverRef: RuntimeOperationFact = input.hoverRef ?? NATIVE_REF_UNAVAILABLE;
  return Object.freeze({
    tapPoint: input.tap,
    tapRef: input.tapRef ?? NATIVE_REF_UNAVAILABLE,
    longPressPoint: input.longPress,
    hoverPoint: input.hover.available
      ? input.hover
      : Object.freeze({ ...input.hover, hint: input.hover.hint ?? HOVER_UNAVAILABLE_HINT }),
    hoverRef: hoverRef.available
      ? hoverRef
      : Object.freeze({
          ...hoverRef,
          hint: hoverRef.hint ?? HOVER_UNAVAILABLE_HINT,
        }),
    fillPoint: input.fill,
    fillRef: input.fillRef ?? NATIVE_REF_UNAVAILABLE,
    tapElementSelector: input.tapElementSelector,
  });
}

const NATIVE_REF_UNAVAILABLE = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);

function runnerContext(input: TouchExecutionInput, signal: AbortSignal): RunnerContext {
  return { ...input.execution, appBundleId: input.appBundleId, signal };
}

function bindTouch(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
  facts: TouchRuntimeOperationFacts,
  pause: (milliseconds: number) => Promise<void>,
): Partial<TouchRuntimeOperations> {
  const interactorFor = async (input: TouchExecutionInput) => {
    signal.throwIfAborted();
    return await resolveInteractor(runnerContext(input, signal));
  };
  const tapPoint = async (input: TapPointInput) => {
    const interactor = await interactorFor(input);
    if (input.options.button !== 'primary' && interactor.alternateClick) {
      return await interactor.alternateClick(input.point, input.options.button);
    }
    if (interactor.pressPoint) {
      return await interactor.pressPoint(input.point, input.options);
    }
    return await executeGenericPress(interactor, input.point, input.options, pause);
  };
  const hoverPoint = async (input: HoverPointInput) => {
    const interactor = await interactorFor(input);
    if (!interactor.hover) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Bound runtime advertised hover without an interactor.',
      );
    }
    return await interactor.hover(input.point.x, input.point.y);
  };
  const fillPoint = async (input: FillPointInput) => {
    const interactor = await interactorFor(input);
    return await interactor.fill(input.point.x, input.point.y, input.text, input.delayMs, {
      allowNonHittableCoordinateFallback: input.allowNonHittableCoordinateFallback,
    });
  };
  return Object.freeze({
    ...(facts.tapPoint.available ? { tapPoint } : {}),
    ...(facts.tapRef.available
      ? {
          tapRef: async (input: TapRefInput) => {
            const interactor = await interactorFor(input);
            if (interactor.tapRef) return await interactor.tapRef(input.ref);
            return missingAdvertisedOperation('tapRef');
          },
        }
      : {}),
    ...(facts.longPressPoint.available
      ? {
          longPressPoint: async (input: LongPressPointInput) => {
            const interactor = await interactorFor(input);
            return await interactor.longPress(input.point.x, input.point.y, input.durationMs);
          },
        }
      : {}),
    ...(facts.hoverPoint.available ? { hoverPoint } : {}),
    ...(facts.hoverRef.available
      ? {
          hoverRef: async (input: HoverRefInput) => {
            const interactor = await interactorFor(input);
            if (interactor.hoverRef) return await interactor.hoverRef(input.ref);
            return missingAdvertisedOperation('hoverRef');
          },
        }
      : {}),
    ...(facts.fillPoint.available ? { fillPoint } : {}),
    ...(facts.fillRef.available
      ? {
          fillRef: async (input: FillRefInput) => {
            const interactor = await interactorFor(input);
            if (interactor.fillRef)
              return await interactor.fillRef(input.ref, input.text, input.delayMs);
            return missingAdvertisedOperation('fillRef');
          },
        }
      : {}),
    ...(facts.tapElementSelector.available
      ? {
          tapElementSelector: async (input: TapElementSelectorInput) => {
            const interactor = await interactorFor(input);
            if (interactor.tapElementSelector)
              return await interactor.tapElementSelector(input.selector);
            return missingAdvertisedOperation('tapElementSelector');
          },
        }
      : {}),
  });
}

function missingAdvertisedOperation(name: string): never {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `Bound runtime advertised ${name} without an interactor.`,
  );
}

async function executeGenericPress(
  interactor: Interactor,
  point: Point,
  options: PressPointOptions,
  pause: (milliseconds: number) => Promise<void>,
): Promise<Record<string, unknown> | void> {
  if (options.button !== 'primary') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `Bound runtime does not implement ${options.button} click.`,
    );
  }
  let first: Record<string, unknown> | void = undefined;
  for (let index = 0; index < options.count; index += 1) {
    const [dx, dy] = pressJitter(index, options.jitterPx);
    const result = options.doubleTap
      ? await interactor.doubleTap(point.x + dx, point.y + dy)
      : options.holdMs > 0
        ? await interactor.longPress(point.x + dx, point.y + dy, options.holdMs)
        : await interactor.tap(point.x + dx, point.y + dy);
    first ??= result;
    if (index < options.count - 1 && options.intervalMs > 0) {
      await pause(options.intervalMs);
    }
  }
  return first;
}

const PRESS_JITTER = [
  [0, 0],
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
] as const;

export function pressJitter(index: number, amount: number): readonly [number, number] {
  if (amount <= 0) return [0, 0];
  const [x, y] = PRESS_JITTER[index % PRESS_JITTER.length]!;
  return [x * amount, y * amount];
}

export function bindLocalTouchInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalInteractorOperationResolver;
    facts: TouchRuntimeOperationFacts;
    pause(milliseconds: number): Promise<void>;
  }>,
): Partial<TouchRuntimeOperations> {
  return bindTouch(params.signal, localInteractorSource(params), params.facts, params.pause);
}

export function bindProviderTouchInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderInteractorOperationResolver;
    facts: TouchRuntimeOperationFacts;
    pause(milliseconds: number): Promise<void>;
  }>,
): Partial<TouchRuntimeOperations> {
  return bindTouch(
    params.signal,
    providerInteractorSource({ ...params, operation: 'touch' }),
    params.facts,
    params.pause,
  );
}
