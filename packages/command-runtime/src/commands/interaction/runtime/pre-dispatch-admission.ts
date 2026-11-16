/**
 * Pre-dispatch admission (ADR 0039) for runtime-resolved press and click: the one step between
 * resolution and the backend call. The static resolution guards have already judged the target.
 * Admission runs the motion check and owns every wait it asks for, under one request budget. The
 * budget is checked last, so no awaited work lies between admission and the send.
 *
 * A raw point has no resolved element to re-observe. A replay step's identity guard (ADR 0012
 * step 4) and a mutating `find`'s carried node (#1654) own what they resolved, and a second look
 * would replace their evidence with another observation, so those targets bypass admission.
 *
 * A target nested in a larger touch control gets one native hittability read first
 * (`refuseUnhittableTarget` below): a control the platform reports as not hittable refuses here, since
 * a tap at its centre would land on another element.
 */
import type {
  InteractionTarget,
  ResolvedInteractionTarget,
} from '@agent-device/contracts/interaction';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import {
  AppError,
  createRequestCanceledError,
  createRequestDeadlineError,
  discloseDispatch,
} from '@agent-device/kernel/errors';
import { observeUntil, type ObservationClock } from '@agent-device/capture-kit/observe-until';
import { now, sleep, toBackendContext } from '../../runtime-common.ts';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { isNestedTouchControl } from '@agent-device/selectors/interaction-targeting';
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

/**
 * `allowNonHittableCoordinateFallback` is the Maestro replay policy: replay taps resolved bounds even
 * when the platform says the element is not hittable, so it keeps the hittability read out.
 */
type AdmissionOptions = CommandContext & {
  target: InteractionTarget;
  allowNonHittableCoordinateFallback?: boolean;
};

export async function admitResolvedTarget(
  runtime: AgentDeviceRuntime,
  options: AdmissionOptions,
  params: ResolveInteractionTargetParams,
  resolved: ResolvedInteractionTarget,
): Promise<ResolvedInteractionTarget> {
  if (resolved.kind === 'point') return resolved;
  const node = resolved.node;
  if (!node?.rect) return resolved;
  if (params.expectedResolvedTarget || params.preresolvedTarget) return resolved;
  const budget = requestBudget(runtime, options);
  await refuseUnhittableTarget(runtime, options, resolved, budget.read);
  const screening = await budget.read(() =>
    screenMotion(runtime, options, node, resolved.preAction),
  );
  const admitted =
    screening.kind === 'pass'
      ? resolved
      : await awaitRest(runtime, options, params, resolved, screening.wait, budget);
  assertWithinBudget(budget);
  return admitted;
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
  // The first read that runs until the deadline arms its timer, so an idle press builds none. The
  // timer arms only within its 32-bit range; a later, infinite or absent deadline is still held by
  // the clock checks.
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
        if (readSignal?.aborted) assertWithinBudget(budget, deadline?.aborted || undefined);
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

/**
 * Looks at the target until the motion check passes or refuses. The transition window was anchored
 * by the screening; every look taken before it gives up earns a full sample gap to the next one.
 * The request deadline ends the loop whatever the window or minimum looks ask.
 */
async function awaitRest(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  resolved: Exclude<ResolvedInteractionTarget, { kind: 'point' }>,
  wait: MotionWait,
  budget: AdmissionBudget,
): Promise<ResolvedInteractionTarget> {
  const startedAtMs = budget.clock.now();
  assertWithinBudget(budget, wait.firstLookAtMs >= budget.deadlineMs);
  if (wait.firstLookAtMs > startedAtMs) await budget.clock.sleep(wait.firstLookAtMs - startedAtMs);
  const loopStartedAtMs = budget.clock.now();
  let restingSinceMs = loopStartedAtMs;
  const observed = await observeUntil<
    MovingTargetObservation,
    Exclude<ReturnType<typeof judgeMotionLook>, { kind: 'wait' }>
  >({
    capture: () =>
      budget.read((signal) => reObserveTarget(runtime, { ...options, signal }, params), 'deadline'),
    verdict: (look, previous) => {
      const verdict = judgeMotionLook(look, previous, restingSinceMs, wait.policy);
      if (verdict.kind !== 'wait') return { kind: 'done', result: verdict };
      restingSinceMs = verdict.restingSinceMs;
      if (look.observedAtMs >= wait.giveUpAtMs) return { kind: 'continue' };
      return {
        kind: 'continue',
        budgetMs: look.observedAtMs - loopStartedAtMs + MOVING_TARGET_GATE_SAMPLE_GAP_MS,
      };
    },
    schedule: {
      intervalMs: MOVING_TARGET_GATE_SAMPLE_GAP_MS,
      budgetMs: wait.giveUpAtMs - loopStartedAtMs,
      minPolls: wait.policy.minLooks,
    },
    clock: budget.clock,
    deadlineMs: budget.deadlineMs,
  });
  const waitedMs = budget.clock.now() - startedAtMs;
  switch (observed.kind) {
    case 'failed':
      throw observed.error;
    case 'deadline':
      assertWithinBudget(budget);
      throw budget.deadlineRefusal();
    case 'expired':
      throw motionRefusal(
        resolved,
        observed.last?.measured ? observed.last.rect : undefined,
        waitedMs,
      );
    case 'done':
      if (observed.result.kind === 'pass') return observed.result.admitted;
      throw motionRefusal(resolved, undefined, waitedMs);
  }
}

type ResolvedElementTarget = Exclude<ResolvedInteractionTarget, { kind: 'point' }>;

/**
 * Whether the resolved target is worth a native hittability read: a touch control nested inside a
 * larger touch control of the tree that measured it, the shape of a swipe action beside its row.
 * Every other press pays nothing.
 */
function needsHittabilityRead(resolved: ResolvedElementTarget): boolean {
  const nodes = resolved.preAction?.nodes;
  return Boolean(resolved.node && nodes && isNestedTouchControl(nodes, resolved.node));
}

/**
 * Asks the backend whether the gated target is hittable, and refuses before any dispatch when the
 * platform says it is not. Every other verdict, and a backend without the probe, admits the target
 * unchanged. `read` carries the admission budget, so cancellation and the request deadline end the
 * look the way they end every other admission wait.
 */
async function refuseUnhittableTarget(
  runtime: AgentDeviceRuntime,
  options: AdmissionOptions,
  resolved: ResolvedElementTarget,
  read: <T>(
    read: (signal: AbortSignal | undefined) => Promise<T>,
    until?: 'deadline',
  ) => Promise<T>,
): Promise<void> {
  const node = resolved.node;
  const probe = runtime.backend.probeTargetHittability;
  if (options.allowNonHittableCoordinateFallback === true) return;
  if (!node || !probe || !needsHittabilityRead(resolved)) return;
  const verdict = await read(
    (signal) =>
      probe.call(runtime.backend, toBackendContext(runtime, { ...options, signal }), node),
    'deadline',
  );
  if (verdict === 'notHittable') throw notHittableRefusal(resolved, node);
}

function notHittableRefusal(
  resolved: ResolvedElementTarget,
  node: NonNullable<ResolvedElementTarget['node']>,
): AppError {
  const selector = resolved.target.kind === 'selector' ? resolved.target.selector : undefined;
  const ref = resolved.target.kind === 'ref' ? resolved.target.ref : undefined;
  const name = node.label?.trim() || node.identifier?.trim() || selector || ref;
  return discloseDispatch(
    new AppError(
      'COMMAND_FAILED',
      `"${name}" is not hittable: a tap would land on another element.`,
      {
        reason: INTERACTION_ERROR_REASONS.targetNotHittable,
        ...(selector !== undefined ? { selector } : { ref }),
        ...(node.rect ? { rect: node.rect } : {}),
        hint: 'Reveal the control (for example swipe its row), then take a fresh snapshot -i.',
      },
    ),
    'no',
  );
}
