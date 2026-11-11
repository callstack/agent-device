import type {
  ResolvedInteractionTarget,
  InteractionTarget,
} from '@agent-device/contracts/interaction';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import type { BackendCommandContext } from '@agent-device/contracts/backend';
import type { NativePressReadiness } from '@agent-device/contracts/selector-observation-runtime';
import { matchesAuthorizedPressTarget } from './press-readiness-binding.ts';
import { readSnapshotNativePressTargets } from '@agent-device/contracts/capture';
import {
  AppError,
  createRequestCanceledError,
  discloseDispatch,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { toBackendContext } from '../../runtime-common.ts';
import type { ResolveInteractionTargetParams } from './interaction-resolution-request.ts';
import { reObserveTarget } from './moving-target-gate.ts';

/** A live necessary condition, not proof that the canonical coordinate is free of partial cover. */
export async function guardPressReadiness(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  original: ResolvedInteractionTarget,
): Promise<ResolvedInteractionTarget> {
  if (!runtime.backend.readPressReadiness || original.kind === 'point') return original;
  const { getRequestExecutionDeadlineMs, getRequestResultDeadlineMs } =
    await import('@agent-device/host-kit/request');
  const deadline = Math.min(
    getRequestExecutionDeadlineMs(options.requestId) ?? Infinity,
    getRequestResultDeadlineMs(options.requestId) ?? Infinity,
  );
  const context = toBackendContext(runtime, options);
  const deadlineSignal = Number.isFinite(deadline)
    ? AbortSignal.timeout(Math.max(0, Math.ceil(deadline - Date.now())))
    : undefined;
  if (deadlineSignal) {
    context.signal = context.signal
      ? AbortSignal.any([context.signal, deadlineSignal])
      : deadlineSignal;
  }
  try {
    return await awaitReadiness(runtime, options, params, original, {
      context,
      deadline,
      deadlineSignal,
    });
  } catch (error) {
    if (error instanceof AppError) throw discloseDispatch(error, 'no');
    throw refusal('native-read-failed', error);
  }
}

async function awaitReadiness(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  original: Exclude<ResolvedInteractionTarget, { kind: 'point' }>,
  budget: {
    context: BackendCommandContext;
    deadline: number;
    deadlineSignal: AbortSignal | undefined;
  },
): Promise<ResolvedInteractionTarget> {
  const { context, deadline, deadlineSignal } = budget;
  let state: NativePressReadiness = 'missing';
  let waited = false;
  try {
    while (true) {
      assertBudget(context, deadline, state, deadlineSignal);
      state = await runtime.backend.readPressReadiness!(
        context,
        nativeTarget(original),
        original.preAction?.surfaceBundleId,
      );
      assertBudget(context, deadline, state, deadlineSignal);
      if (state === 'ready') break;
      // This is post-resolution readiness, never a wait for a selector that does not exist.
      if (
        state !== 'blocked' ||
        !Number.isFinite(deadline) ||
        params.expectedResolvedTarget ||
        params.preresolvedTarget
      )
        throw refusal(state);
      await sleep(Math.min(50, deadline - Date.now()), context.signal);
      waited = true;
    }
    const ready = waited
      ? await revalidate(runtime, { ...options, signal: context.signal }, params, original)
      : original;
    assertBudget(context, deadline, state, deadlineSignal);
    return ready;
  } catch (error) {
    if (!(error instanceof AppError) || (context.signal?.aborted && isRequestCanceledError(error)))
      assertBudget(context, deadline, state, deadlineSignal, error);
    throw error;
  }
}

function nativeTarget(resolved: Exclude<ResolvedInteractionTarget, { kind: 'point' }>) {
  const source =
    resolved.preAction &&
    resolved.node &&
    readSnapshotNativePressTargets(resolved.preAction.nodes)?.get(resolved.node.index);
  if (!source || !resolved.point) throw refusal('missing-source-binding');
  return source;
}

async function revalidate(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  original: Exclude<ResolvedInteractionTarget, { kind: 'point' }>,
): Promise<Exclude<ResolvedInteractionTarget, { kind: 'point' }>> {
  const observed = await reObserveTarget(runtime, options, params);
  const fresh = observed.resolved;
  if (
    !observed.measured ||
    fresh.kind === 'point' ||
    observed.surfaceBundleId !== original.preAction?.surfaceBundleId
  )
    throw refusal('changed');
  const before = original.node;
  const after = fresh.node;
  if (!before?.type || !before.rect || !original.point || !after?.type || !after.rect)
    throw refusal('changed');
  if (
    !matchesAuthorizedPressTarget(
      { ...before, type: before.type, rect: before.rect },
      { ...after, type: after.type, rect: after.rect },
    )
  )
    throw refusal('changed');
  if (!matchesAuthorizedPressTarget(nativeTarget(original), nativeTarget(fresh)))
    throw refusal('changed');
  // The target is authorized, not a stale numeric point: this capture re-ran parent/child guards.
  return fresh;
}

function assertBudget(
  context: BackendCommandContext,
  deadline: number,
  state: NativePressReadiness,
  deadlineSignal?: AbortSignal,
  cause?: unknown,
): void {
  if (context.signal?.aborted) {
    const reason: unknown = context.signal.reason;
    if (reason instanceof AppError) throw reason;
    if (reason !== deadlineSignal?.reason)
      throw createRequestCanceledError(undefined, cause ?? reason);
    throw refusal(state, cause ?? reason);
  }
  if (Date.now() >= deadline) throw refusal(state, cause);
}

function refusal(state: string, cause?: unknown): AppError {
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
