import { gestureRefusalMessage } from '@agent-device/contracts/gesture-admission';
import type { GestureCommandInput, GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import type {
  GesturePlanInput,
  GestureRuntimeOperations,
} from '@agent-device/contracts/gesture-runtime';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import {
  resolveGestureRuntimePlan,
  type GestureRuntimePlan,
} from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import type { DaemonCommandContext } from './context.ts';
import type { DaemonFailureResponse } from './handlers/response.ts';
import { admitRuntimeOperations, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

/**
 * One request's bound gesture authority. `gesture` and `swipe` both build their plans inside the
 * shared client-side orchestration, which can execute several plans per request (`swipe --count`,
 * a drag's resolved endpoints), so the executor is a closure over the single binding rather than
 * a value frozen at bind time.
 */
export type BoundGestureExecutor = Readonly<{
  captureSnapshot: (input: CaptureSnapshotInput) => Promise<SnapshotResult>;
  performPlan: (
    plan: GesturePlan,
    context: DaemonCommandContext,
  ) => Promise<Record<string, unknown> | void>;
  /**
   * Present only when the admitted owner advertised its own frame read. Absence is not a failure:
   * the caller derives the frame from a capture instead, exactly as it does today for an owner
   * without one (Linux).
   */
  gestureViewport?: (context: DaemonCommandContext) => Promise<Rect>;
}>;

export type ResolvedGestureRuntime =
  | Readonly<{ ok: false; response: DaemonFailureResponse }>
  | Readonly<{ ok: true; gestures: BoundGestureExecutor }>;

/**
 * The one place `gesture` and `swipe` reach a device (ADR 0019). The gesture input selects ONE
 * execution tier, admission inspects that tier's fact on the exact owner, and the handler binds
 * once — before any plan is built, so a device that cannot synthesize this gesture is refused
 * where the retired `requireGestureSupported` refused it rather than mid-series.
 *
 * The refusal message is composed from the tier and the device so every string the retired
 * admission produced survives verbatim; the hint comes from the owner's own fact.
 */
export async function resolveBoundGestureRuntime(
  params: {
    device: DeviceInfo;
    /** The normalized gesture — for `swipe`, the fling its motion normalizes to. */
    input: GestureCommandInput;
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGestureRuntime> {
  const plan = resolveGestureRuntimePlan(params.input);
  const admitted = await admitRuntimeOperations({
    command: 'gesture',
    device: params.device,
    required: plan.use.required,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
    // The retired admission THREW an `AppError`, which the gesture handler's catch normalized —
    // so the refusal is built the same way here. Going through `errorResponse` instead would
    // drop the code's default hint and its `retriable` classification from the wire shape.
    unavailableResponse: (unavailable) => ({
      ok: false,
      error: normalizeError(
        new AppError(
          'UNSUPPORTED_OPERATION',
          gestureRefusalMessage(params.device, plan.tier, params.input.intent),
          {
            gesture: params.input.intent,
            ...(unavailable.hint === undefined ? {} : { hint: unavailable.hint }),
          },
        ),
      ),
    }),
  });
  if (admitted.type === 'response') return { ok: false, response: admitted.response };
  // One bind, with the exactly-typed use the tier selected (ADR 0019 §9).
  return { ok: true, gestures: await bindGestureTier(admitted.bind, params.device, plan) };
}

/**
 * The ONE place each bound gesture tier executes (R52/R54, shared by `gesture` and `swipe`).
 *
 * Each branch binds its own exactly-typed use, so the operation it calls is non-optional by
 * construction — no cast, no non-null repair, and exactly one lexical owner per tier, which is
 * what lets the cutover gate prove no parallel route exists. The branches read alike because
 * the tiers share their mechanics; what differs is the cell each one proves.
 */
async function bindGestureTier(
  bind: Extract<Awaited<ReturnType<typeof admitRuntimeOperations>>, { type: 'admitted' }>['bind'],
  device: DeviceInfo,
  plan: GestureRuntimePlan,
): Promise<BoundGestureExecutor> {
  switch (plan.tier) {
    case 'plan': {
      const runtime = await bind(device, plan.use);
      return {
        performPlan: async (gesturePlan, context) =>
          await runtime.operations.performGesturePlan(gesturePlanInput(gesturePlan, context)),
        ...selectGestureFrame(runtime),
      };
    }
    case 'directional-fling': {
      const runtime = await bind(device, plan.use);
      return {
        performPlan: async (gesturePlan, context) =>
          await runtime.operations.performDirectionalFlingPlan(
            gesturePlanInput(gesturePlan, context),
          ),
        ...selectGestureFrame(runtime),
      };
    }
    case 'multi-touch': {
      const runtime = await bind(device, plan.use);
      return {
        performPlan: async (gesturePlan, context) =>
          await runtime.operations.performMultiTouchGesturePlan(
            gesturePlanInput(gesturePlan, context),
          ),
        ...selectGestureFrame(runtime),
      };
    }
    case 'target-authored-drag': {
      const runtime = await bind(device, plan.use);
      return {
        performPlan: async (gesturePlan, context) =>
          await runtime.operations.performTargetAuthoredDrag(
            gesturePlanInput(gesturePlan, context),
          ),
        ...selectGestureFrame(runtime),
      };
    }
  }
}

/** Keeps both viewport paths inside the request's admitted gesture binding. */
function selectGestureFrame(
  runtime: Readonly<{
    operations: Readonly<{
      captureSnapshot: (input: CaptureSnapshotInput) => Promise<SnapshotResult>;
      gestureViewport?: GestureRuntimeOperations['gestureViewport'];
    }>;
  }>,
): Pick<BoundGestureExecutor, 'captureSnapshot' | 'gestureViewport'> {
  const { gestureViewport } = runtime.operations;
  const selected = gestureViewport ? { operations: { gestureViewport } } : undefined;
  return Object.freeze({
    captureSnapshot: async (input: CaptureSnapshotInput) =>
      await runtime.operations.captureSnapshot(input),
    ...(selected
      ? {
          gestureViewport: async (context: DaemonCommandContext) =>
            await selected.operations.gestureViewport(gestureViewportInput(context)),
        }
      : {}),
  });
}

/** The neutral intent one gesture carries, projected from a resolved command context. */
function gesturePlanInput(plan: GesturePlan, context: DaemonCommandContext): GesturePlanInput {
  return {
    plan,
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

function gestureViewportInput(context: DaemonCommandContext) {
  return {
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}
