import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Rect } from '@agent-device/kernel/snapshot';
import type { GesturePlan } from './gesture-plan-types.ts';
import {
  localInteractorSource,
  providerInteractorSource,
  type LocalInteractorOperationResolver,
  type ProviderInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import { invalidRuntimeContract } from './runtime-contract-error.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for executing one typed gesture plan (ADR 0013). The plan is already built —
 * from the coordinates, preset, or resolved drag targets a caller normalized — so the operation
 * names no command, request, session, or CLI flag.
 */
export type GesturePlanInput = Readonly<{
  plan: GesturePlan;
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/** Reading the gesture coordinate frame needs no plan — only the owner's authority. */
export type GestureViewportInput = Readonly<{
  options?: Readonly<{ appBundleId?: string }>;
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * The gesture family's execution surface.
 *
 * The four plan operations run the SAME mechanics — one `Interactor.performGesture` call — and
 * are separate keys because their **cells** differ, not their implementations. That is the shape
 * `SnapshotRuntimeOperations` already uses for its three capture keys: an owner declares each
 * requirement it can actually meet, and a command requires exactly the tier its input selected,
 * so a device is refused where the retired `requireGestureSupported` refused it instead of
 * failing mid-execution.
 *
 * The tiers, and the retired admission each one restates:
 * - `performGesturePlan` — one-contact fling/pan, and every `swipe`. Refused where the legacy
 *   check refused a plain gesture (web, watchOS, visionOS).
 * - `performDirectionalFlingPlan` — `gesture fling --direction`, whose speed semantics Linux
 *   cannot honor even though it executes coordinate flings through its drag primitive.
 * - `performMultiTouchGesturePlan` — pinch/rotate/transform and two-pointer pan. On Apple this is
 *   the two-finger XCTest synthesis, which is iOS/iPadOS **simulator** only.
 * - `performTargetAuthoredDrag` — `gesture drag`, which needs an adapter preserving source hold,
 *   timed movement, and destination hold.
 */
export type GestureRuntimeOperations = Readonly<{
  performGesturePlan(input: GesturePlanInput): Promise<Record<string, unknown> | void>;
  performDirectionalFlingPlan(input: GesturePlanInput): Promise<Record<string, unknown> | void>;
  performMultiTouchGesturePlan(input: GesturePlanInput): Promise<Record<string, unknown> | void>;
  performTargetAuthoredDrag(input: GesturePlanInput): Promise<Record<string, unknown> | void>;
  /**
   * The owner's own gesture coordinate frame. Callers without it derive the frame from their
   * admitted snapshot capture.
   */
  gestureViewport(input: GestureViewportInput): Promise<Rect>;
}>;

export type GestureRuntimeOperationFacts = Readonly<{
  performGesturePlan: RuntimeOperationFact;
  performDirectionalFlingPlan: RuntimeOperationFact;
  performMultiTouchGesturePlan: RuntimeOperationFact;
  performTargetAuthoredDrag: RuntimeOperationFact;
  gestureViewport: RuntimeOperationFact;
}>;

/** Builds the exhaustive owner claims for the five gesture requirements. */
export function gestureRuntimeOperationFacts(
  input: Readonly<{
    plan: RuntimeOperationFact;
    directionalFling: RuntimeOperationFact;
    multiTouch: RuntimeOperationFact;
    targetAuthoredDrag: RuntimeOperationFact;
    viewport: RuntimeOperationFact;
  }>,
): GestureRuntimeOperationFacts {
  return Object.freeze({
    performGesturePlan: input.plan,
    performDirectionalFlingPlan: input.directionalFling,
    performMultiTouchGesturePlan: input.multiTouch,
    performTargetAuthoredDrag: input.targetAuthoredDrag,
    gestureViewport: input.viewport,
  });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding, and
 * exposes only the tiers that owner's own facts admitted.
 *
 * The per-tier gating lives HERE rather than in each of the eight runtime owners: the tiers share
 * one executor, so eight copies of the same five-branch spread would be duplication of mechanism
 * — and the next tier added would cost eight more edits.
 */
function bindGestureOperations(
  facts: GestureRuntimeOperationFacts,
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): Partial<GestureRuntimeOperations> {
  const performPlan = async (input: GesturePlanInput) => {
    const interactor = await resolveGestureInteractor(signal, resolveInteractor, input);
    // Facts advertised gesture execution but the owner's interactor cannot perform it. That is a
    // contract violation, not a refusal (ADR 0019 §2): degrading here would execute nothing and
    // report success.
    if (typeof interactor.performGesture !== 'function') {
      throw invalidRuntimeContract(
        'Runtime owner advertised gesture execution without an interactor implementation',
      );
    }
    return await interactor.performGesture(input.plan);
  };
  return Object.freeze({
    ...(facts.performGesturePlan.available ? { performGesturePlan: performPlan } : {}),
    ...(facts.performDirectionalFlingPlan.available
      ? { performDirectionalFlingPlan: performPlan }
      : {}),
    ...(facts.performMultiTouchGesturePlan.available
      ? { performMultiTouchGesturePlan: performPlan }
      : {}),
    ...(facts.performTargetAuthoredDrag.available
      ? { performTargetAuthoredDrag: performPlan }
      : {}),
    ...(facts.gestureViewport.available
      ? {
          gestureViewport: async (input: GestureViewportInput) => {
            const interactor = await resolveGestureInteractor(signal, resolveInteractor, input);
            if (typeof interactor.gestureViewport !== 'function') {
              throw invalidRuntimeContract(
                'Runtime owner advertised gestureViewport without an interactor implementation',
              );
            }
            return await interactor.gestureViewport();
          },
        }
      : {}),
  });
}

async function resolveGestureInteractor(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
  input: GesturePlanInput | GestureViewportInput,
): Promise<Interactor> {
  signal.throwIfAborted();
  return await resolveInteractor({
    ...input.execution,
    appBundleId: input.options?.appBundleId,
    signal,
  });
}

export type LocalGestureInteractorResolver = LocalInteractorOperationResolver;

export function bindLocalGestureInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    facts: GestureRuntimeOperationFacts;
    resolveInteractor: LocalGestureInteractorResolver;
  }>,
): Partial<GestureRuntimeOperations> {
  return bindGestureOperations(params.facts, params.signal, localInteractorSource(params));
}

export type ProviderGestureInteractorResolver = ProviderInteractorOperationResolver;

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderGestureInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    facts: GestureRuntimeOperationFacts;
    resolveInteractor: ProviderGestureInteractorResolver;
  }>,
): Partial<GestureRuntimeOperations> {
  return bindGestureOperations(
    params.facts,
    params.signal,
    providerInteractorSource({ ...params, operation: 'gesture' }),
  );
}
