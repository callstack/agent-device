/**
 * Pre-dispatch admission (ADR 0039) for runtime-resolved press and click: the one step between
 * resolution and the backend call. The static resolution guards have already judged the target.
 * Admission runs motion and native readiness checks under one request budget. The budget is checked
 * last, so no awaited work lies between admission and the send.
 *
 * A raw point has no resolved element to re-observe. A replay step's identity guard (ADR 0012
 * step 4) and a mutating `find`'s carried node (#1654) own what they resolved, and a second look
 * would replace their evidence with another observation, so those targets bypass admission.
 */
import type {
  InteractionTarget,
  ResolvedInteractionTarget,
} from '@agent-device/contracts/interaction';
import type { BackendTapOptions } from '@agent-device/contracts/backend';
import type { NativePressReadiness } from '@agent-device/contracts/selector-observation-runtime';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import {
  AppError,
  createRequestCanceledError,
  createRequestDeadlineError,
  discloseDispatch,
  isRequestCanceledError,
  isRequestDeadlineDetails,
} from '@agent-device/kernel/errors';
import { observeUntil, type ObservationClock } from '@agent-device/capture-kit/observe-until';
import { now, sleep, toBackendContext } from '../../runtime-common.ts';
import {
  judgeMotionLook,
  motionRefusal,
  MOVING_TARGET_GATE_SAMPLE_GAP_MS,
  reObserveTarget,
  screenMotion,
  type MotionWait,
  type MovingTargetObservation,
} from './moving-target-gate.ts';
import type { ResolveInteractionTargetParams } from './interaction-resolution-request.ts';
import { readSnapshotNativePressTargets } from '@agent-device/contracts/capture';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';

export async function admitResolvedTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext & BackendTapOptions & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  resolved: ResolvedInteractionTarget,
): Promise<ResolvedInteractionTarget> {
  if (resolved.kind === 'point' || !resolved.node?.rect) return resolved;
  if (params.expectedResolvedTarget || params.preresolvedTarget) return resolved;
  const budget = requestBudget(runtime, options);
  const screening = await budget.read(() =>
    screenMotion(runtime, options, resolved.node!, resolved.preAction),
  );
  const native =
    !!runtime.backend.readPressReadiness &&
    (options.count ?? 1) === 1 &&
    (options.intervalMs ?? 0) === 0 &&
    (options.holdMs ?? 0) === 0 &&
    (options.jitterPx ?? 0) === 0 &&
    options.doubleTap !== true &&
    (options.button ?? 'primary') === 'primary';
  if (screening.kind === 'pass' && !native) {
    assertWithinBudget(budget);
    return resolved;
  }
  return awaitAdmission(
    runtime,
    options,
    params,
    {
      resolved,
      generation: 0,
      native,
      ...(screening.kind === 'wait' ? { motion: motionObservation(screening.wait) } : {}),
    },
    budget,
  );
}

/**
 * The one hard bound of every admission wait: the request's cancellation signal and its deadline,
 * stated in the runtime clock the checks read.
 */
type AdmissionBudget = Readonly<{
  signal: AbortSignal | undefined;
  deadlineMs: number;
  clock: ObservationClock;
  /**
   * Runs one awaited read with the budget checked before and after it. With `until: 'deadline'`,
   * the read receives a signal that also aborts at the request deadline, so a read in flight ends
   * there and refuses.
   */
  read<T>(read: (signal: AbortSignal | undefined) => Promise<T>, until?: 'deadline'): Promise<T>;
  /** The refusal of a wait the remaining request time cannot cover, before any send. */
  deadlineRefusal(): AppError;
}>;

function requestBudget(runtime: AgentDeviceRuntime, options: CommandContext): AdmissionBudget {
  const signal = options.signal ?? runtime.signal;
  // The first read that runs until the deadline arms its timer. Paths with no bounded read build
  // none. The timer arms only within its 32-bit range; a later, infinite or absent deadline is still
  // held by the clock checks.
  let deadlineSignals:
    | Readonly<{ read: AbortSignal | undefined; deadline: AbortSignal | undefined }>
    | undefined;
  const armDeadline = () => {
    const remainingMs = Math.max(0, Math.ceil((options.deadlineAtMs ?? Infinity) - Date.now()));
    const deadline = remainingMs <= 2 ** 31 - 1 ? AbortSignal.timeout(remainingMs) : undefined;
    const read = signal && deadline ? AbortSignal.any([signal, deadline]) : (signal ?? deadline);
    return { read, deadline };
  };
  const budget: AdmissionBudget = {
    signal,
    deadlineMs: now(runtime) + ((options.deadlineAtMs ?? Infinity) - Date.now()),
    clock: {
      now: () => now(runtime),
      sleep: async (ms) => {
        assertWithinBudget(budget);
        await sleep(runtime, ms, signal);
      },
    },
    read: async (read, until) => {
      assertWithinBudget(budget);
      const { read: readSignal, deadline } = until
        ? (deadlineSignals ??= armDeadline())
        : { read: signal, deadline: undefined };
      let value;
      try {
        value = await read(readSignal);
      } catch (error) {
        if (readSignal?.aborted && (!(error instanceof AppError) || isRequestCanceledError(error)))
          assertWithinBudget(budget, deadline?.aborted || undefined);
        throw error;
      }
      assertWithinBudget(budget, deadline?.aborted || undefined);
      return value;
    },
    deadlineRefusal: () => {
      const remainingMs = Math.max(0, Math.round(budget.deadlineMs - budget.clock.now()));
      return discloseDispatch(
        createRequestDeadlineError({
          ...(options.requestId ? { requestId: options.requestId } : {}),
          remainingMs,
          hint: `The request had ${remainingMs} ms left when pre-dispatch admission stopped, so nothing was dispatched. Retry once the UI is idle, or allow the request more time.`,
        }),
        'no',
      );
    },
  };
  return budget;
}

/**
 * Refuses before any send once the request is canceled, or once its deadline passed or the
 * remaining time cannot cover the wait (`deadlineReached`).
 */
function assertWithinBudget(
  budget: AdmissionBudget,
  deadlineReached = budget.clock.now() >= budget.deadlineMs,
): void {
  const { signal } = budget;
  if (signal?.aborted) {
    const details = signal.reason instanceof AppError ? signal.reason.details : undefined;
    throw discloseDispatch(createRequestCanceledError(details, signal.reason), 'no');
  }
  if (deadlineReached) throw budget.deadlineRefusal();
}

/** Captured bindings and live facts use explicit request-local generations, never array identity. */
type AdmissionState = {
  resolved: Exclude<ResolvedInteractionTarget, { kind: 'point' }>;
  generation: number;
  native: boolean;
  live?: {
    source: 'native-press-readiness';
    surfaceBundleId: string | undefined;
    generation: number;
    state: NativePressReadiness;
  };
  blockedGeneration?: number;
  motion?: ReturnType<typeof motionObservation>;
};

function motionObservation(wait: MotionWait) {
  return {
    wait,
    looks: 0,
    endsAtMs: wait.giveUpAtMs,
    restingSinceMs: 0,
    previous: undefined as MovingTargetObservation | undefined,
  };
}

/** The only admission loop. Checks may request another observation, but own no polling or timer. */
async function awaitAdmission(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  state: AdmissionState,
  budget: AdmissionBudget,
): Promise<ResolvedInteractionTarget> {
  const observed = await observeUntil<boolean, ResolvedInteractionTarget>({
    capture: async () => {
      if (state.motion && !(await checkMotion(runtime, options, params, state, budget)))
        return false;
      if (!state.native) return true;
      if (!(await checkReadiness(runtime, options, state, budget))) return false;
      if (state.blockedGeneration !== state.generation) return true;
      // A later Ready fact cannot authorize a capture made before the wait. Resolve once, then
      // probe that new binding; a first-ready result on this generation needs no further capture.
      await refreshAdmission(runtime, options, params, state, budget);
      if (state.motion) return false;
      return checkReadiness(runtime, options, state, budget);
    },
    verdict: (ready) => (ready ? { kind: 'done', result: state.resolved } : { kind: 'continue' }),
    schedule: { intervalMs: MOVING_TARGET_GATE_SAMPLE_GAP_MS, budgetMs: Infinity },
    clock: {
      now: budget.clock.now,
      sleep: (ms) => {
        const motion = state.motion;
        const remaining =
          motion && motion.looks >= motion.wait.policy.minLooks
            ? Math.max(0, motion.endsAtMs - budget.clock.now())
            : ms;
        return budget.clock.sleep(Math.min(ms, remaining));
      },
    },
    deadlineMs: budget.deadlineMs,
  });
  if (observed.kind === 'failed') throw admissionFailure(observed.error, state);
  if (observed.kind !== 'done') {
    try {
      assertWithinBudget(budget);
    } catch (error) {
      throw admissionFailure(error, state);
    }
    throw admissionFailure(budget.deadlineRefusal(), state);
  }
  assertWithinBudget(budget);
  return observed.result;
}

async function checkMotion(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  state: AdmissionState,
  budget: AdmissionBudget,
): Promise<boolean> {
  const motion = state.motion!;
  if (motion.looks === 0) {
    assertWithinBudget(budget, motion.wait.firstLookAtMs >= budget.deadlineMs);
    const delay = motion.wait.firstLookAtMs - budget.clock.now();
    if (delay > 0) await budget.clock.sleep(delay);
    motion.restingSinceMs = budget.clock.now();
  }
  const look = await budget.read(
    (signal) => reObserveTarget(runtime, { ...options, signal }, params),
    'deadline',
  );
  state.generation++;
  const verdict = judgeMotionLook(look, motion.previous, motion.restingSinceMs, motion.wait.policy);
  motion.looks++;
  motion.previous = look;
  if (verdict.kind === 'pass' && verdict.admitted.kind !== 'point') {
    state.resolved = verdict.admitted;
    state.motion = undefined;
    return true;
  }
  if (verdict.kind === 'refuse') throw motionRefusal(state.resolved, undefined, 0);
  if (verdict.kind === 'wait') motion.restingSinceMs = verdict.restingSinceMs;
  if (look.observedAtMs < motion.wait.giveUpAtMs)
    motion.endsAtMs = Math.max(
      motion.endsAtMs,
      look.observedAtMs + MOVING_TARGET_GATE_SAMPLE_GAP_MS,
    );
  if (motion.looks >= motion.wait.policy.minLooks && look.observedAtMs >= motion.endsAtMs)
    throw motionRefusal(state.resolved, look.rect, look.observedAtMs - motion.wait.firstLookAtMs);
  return false;
}

async function checkReadiness(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  state: AdmissionState,
  budget: AdmissionBudget,
): Promise<boolean> {
  try {
    await budget.read(async (signal) => {
      const readiness = await runtime.backend.readPressReadiness!(
        toBackendContext(runtime, { ...options, signal }),
        nativePressTarget(state.resolved),
        state.resolved.preAction?.surfaceBundleId,
      );
      state.live = {
        source: 'native-press-readiness',
        surfaceBundleId: state.resolved.preAction?.surfaceBundleId,
        generation: state.generation,
        state: readiness,
      };
    }, 'deadline');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw readinessRefusal('native-read-failed', error);
  }
  const live = state.live!;
  if (live.state === 'ready') return true;
  if (live.state !== 'blocked' || !Number.isFinite(budget.deadlineMs))
    throw readinessRefusal(live.state);
  state.blockedGeneration = live.generation;
  return false;
}

async function refreshAdmission(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  state: AdmissionState,
  budget: AdmissionBudget,
): Promise<void> {
  state.live = undefined;
  const fresh = await budget.read(
    (signal) => reObserveTarget(runtime, { ...options, signal }, params),
    'deadline',
  );
  if (
    !fresh.measured ||
    fresh.resolved.kind === 'point' ||
    fresh.surfaceBundleId !== state.resolved.preAction?.surfaceBundleId
  )
    throw readinessRefusal('changed');
  const resolved = fresh.resolved;
  state.resolved = resolved;
  state.generation++;
  const screening = await budget.read(() =>
    screenMotion(runtime, options, resolved.node!, resolved.preAction),
  );
  if (screening.kind === 'wait') state.motion = motionObservation(screening.wait);
}

function admissionFailure(error: unknown, state: AdmissionState): unknown {
  if (!(error instanceof AppError)) return error;
  if (isRequestDeadlineDetails(error.details) && state.live)
    error.details = { ...error.details, check: 'native-readiness', readiness: state.live.state };
  return discloseDispatch(error, 'no');
}

/** The producer's unclipped native identity, not the public canonical projection. */
function nativePressTarget(resolved: Exclude<ResolvedInteractionTarget, { kind: 'point' }>) {
  const source =
    resolved.preAction &&
    resolved.node &&
    readSnapshotNativePressTargets(resolved.preAction.nodes)?.get(resolved.node.index);
  if (!source || !resolved.point) throw readinessRefusal('missing-source-binding');
  return source;
}

function readinessRefusal(state: string, cause?: unknown): AppError {
  return discloseDispatch(
    new AppError(
      'COMMAND_FAILED',
      'Resolved target was not ready for input; nothing was dispatched',
      {
        reason: INTERACTION_ERROR_REASONS.targetNotReady,
        readiness: state,
        hint: 'Inspect the current surface and retry when the intended control is available. For an @ref, run snapshot -i and retry with a selector; re-observation can retire the old ref.',
      },
      cause,
    ),
    'no',
  );
}
