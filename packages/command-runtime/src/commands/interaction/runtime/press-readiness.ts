import type {
  ResolvedInteractionTarget,
  InteractionTarget,
} from '@agent-device/contracts/interaction';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import type {
  AuthorizedPressTarget,
  NativePressReadiness,
} from '@agent-device/contracts/selector-observation-runtime';
import {
  getRequestExecutionDeadlineMs,
  getRequestResultDeadlineMs,
} from '@agent-device/host-kit/request';
import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import { matchesAuthorizedPressTarget } from '@agent-device/contracts/selector-observation-runtime';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { toBackendContext } from '../../runtime-common.ts';
import type { ResolveInteractionTargetParams } from './interaction-resolution-request.ts';
import { reObserveTarget } from './moving-target-gate.ts';

/** A live necessary condition, not proof that the preserved coordinate is free of partial cover. */
export async function guardPressReadiness(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  original: ResolvedInteractionTarget,
): Promise<ResolvedInteractionTarget> {
  if (
    !runtime.backend.readPressReadiness ||
    original.kind === 'point' ||
    !original.node?.rect ||
    !original.point
  )
    return original;
  if (!original.node.type) throw refusal('missing');
  const context = toBackendContext(runtime, options);
  const target: AuthorizedPressTarget = {
    type: original.node.type,
    identifier: original.node.identifier,
    label: original.node.label,
    value: original.node.value,
    rect: original.node.rect,
    point: original.point,
  };
  const deadline = Math.min(
    getRequestExecutionDeadlineMs(options.requestId) ?? Infinity,
    getRequestResultDeadlineMs(options.requestId) ?? Infinity,
  );
  if (Number.isFinite(deadline)) {
    const budgetSignal = AbortSignal.timeout(Math.max(0, Math.ceil(deadline - Date.now())));
    context.signal = context.signal
      ? AbortSignal.any([context.signal, budgetSignal])
      : budgetSignal;
  }
  let state: NativePressReadiness = 'missing';
  let current: ResolvedInteractionTarget = original;
  try {
    while (true) {
      context.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw refusal(state);
      state = await runtime.backend.readPressReadiness(
        context,
        target,
        original.preAction?.surfaceBundleId,
      );
      context.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw refusal(state);
      if (state === 'ready') return current;
      if (state === 'ambiguous' || !Number.isFinite(deadline) || Date.now() >= deadline)
        throw refusal(state);
      // A missing native match can mean a covered control. It is never permission to wait for a
      // missing selector: the original canonical authorization must still exist at every poll.
      if (params.expectedResolvedTarget || params.preresolvedTarget) throw refusal(state);
      await waitForNextRead(context.signal, Math.min(50, deadline - Date.now()));
      const observed = await reObserveTarget(
        runtime,
        { ...options, signal: context.signal },
        params,
      );
      const node = observed.resolved.kind === 'point' ? undefined : observed.resolved.node;
      if (
        !observed.measured ||
        observed.surfaceBundleId !== original.preAction?.surfaceBundleId ||
        !node?.type ||
        !node.rect ||
        !matchesAuthorizedPressTarget(target, { ...node, type: node.type, rect: node.rect })
      )
        throw refusal('changed');
      // All canonical guards just ran again, but the input point remains the originally authorized one.
      current = { ...observed.resolved, point: original.point };
    }
  } catch (error) {
    if (error instanceof AppError) throw discloseDispatch(error, 'no');
    throw refusal(state, error);
  }
}

function refusal(state: string, cause?: unknown): AppError {
  return discloseDispatch(
    new AppError(
      'COMMAND_FAILED',
      'Resolved target was not ready for input; nothing was dispatched',
      {
        reason: INTERACTION_ERROR_REASONS.targetNotReady,
        readiness: state,
        hint: 'Inspect the current surface and retry when the intended control is available.',
      },
      cause,
    ),
    'no',
  );
}

async function waitForNextRead(signal: AbortSignal | undefined, ms: number): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
  signal?.throwIfAborted();
}
