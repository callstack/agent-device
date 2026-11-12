import type { ClickButton } from '@agent-device/contracts/click-button';
import type {
  FillCommandResult,
  PreresolvedInteractionTarget,
  PressCommandResult,
  RepeatedInput,
  ResolvedInteractionTarget,
  ResolvedTarget,
} from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import type { Point } from '@agent-device/kernel/snapshot';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import { isFillableType } from '@agent-device/contracts/snapshot';
import { attachResolvedInteractionTarget } from '@agent-device/host-kit/interaction-outcome';
import { sleep, toBackendContext } from '../../runtime-common.ts';
import { toBackendResult, type RuntimeCommand } from '../../runtime-types.ts';
import {
  applyPostActionObservation,
  planPostActionObservation,
  type PostActionObservationOptions,
} from './post-action-observation.ts';
import { resolveInteractionTarget, type InteractionTarget } from './resolution.ts';
import { admitResolvedTarget } from './pre-dispatch-admission.ts';
import { pointObservationOf } from './target-visibility-stages.ts';
import { dispatchNativeRefInteraction } from './native-ref-interaction.ts';
import type {
  ExpectedResolvedTarget,
  ResolveInteractionTargetParams,
} from './interaction-resolution-request.ts';

export { hoverCommand, longPressCommand } from './gestures.ts';
export type {
  HoverCommandOptions,
  HoverCommandResult,
  LongPressCommandOptions,
  LongPressCommandResult,
} from './gestures.ts';
export type { InteractionTarget } from './resolution.ts';

export type PressCommandOptions = CommandContext &
  RepeatedInput & {
    target: InteractionTarget;
    button?: ClickButton;
    /**
     * Multi-ref press plan (`press @e13,@e14,...`): every member in dispatch
     * order, bare ref bodies; `target` repeats member 0 for the response's
     * ref identity. Absent for a single-ref press. One ADR 0014 logical
     * command: every member resolves and admits against the active frame
     * before the first press; see tapRefPlanCommand.
     */
    refs?: readonly string[];
    /** ADR 0012 step 4: replay-only post-resolution guard; see resolution.ts. */
    expectedResolvedTarget?: ExpectedResolvedTarget;
    /** #1654: a mutating `find`'s already-resolved node; see resolution.ts. */
    preresolvedTarget?: PreresolvedInteractionTarget;
  } & PostActionObservationOptions;

export type ClickCommandOptions = PressCommandOptions;

export type { FillCommandResult, PressCommandResult };

export type FillCommandOptions = CommandContext & {
  target: InteractionTarget;
  text: string;
  delayMs?: number;
  /** Internal Maestro replay policy, forwarded only to the platform action. */
  allowNonHittableCoordinateFallback?: boolean;
  /** ADR 0012 step 4: replay-only post-resolution guard; see resolution.ts. */
  expectedResolvedTarget?: ExpectedResolvedTarget;
  /** #1654: a mutating `find`'s already-resolved node; see resolution.ts. */
  preresolvedTarget?: PreresolvedInteractionTarget;
} & PostActionObservationOptions;

export const pressCommand: RuntimeCommand<PressCommandOptions, PressCommandResult> = async (
  runtime,
  options,
): Promise<PressCommandResult> => await tapCommand(runtime, options, 'press');

export const clickCommand: RuntimeCommand<ClickCommandOptions, PressCommandResult> = async (
  runtime,
  options,
): Promise<PressCommandResult> => await tapCommand(runtime, options, 'click');

export const fillCommand: RuntimeCommand<FillCommandOptions, FillCommandResult> = async (
  runtime,
  options,
): Promise<FillCommandResult> => {
  // `''` is a VALUE here — `fill <target> ""` is the clear-field primitive (#2063) — so this
  // runtime guard for untyped callers checks presence, not truthiness.
  if (typeof options.text !== 'string') {
    throw new AppError('INVALID_ARGS', 'fill requires text');
  }
  const observation = planPostActionObservation(options);
  const nativeRefFill = observation.needsPreActionBaseline
    ? null
    : await maybeFillRefTarget(runtime, options);
  if (nativeRefFill) return nativeRefFill;

  const resolved = await resolveInteractionTarget(runtime, options, {
    action: 'fill',
    requireInteractive: true,
    pipeline: SELECTOR_PIPELINE_POLICIES.resolvedTarget,
    captureEvidenceBaseline: observation.needsPreActionBaseline,
    expectedResolvedTarget: options.expectedResolvedTarget,
    preresolvedTarget: options.preresolvedTarget,
  });
  if (!runtime.backend.fill) {
    throw new AppError('UNSUPPORTED_OPERATION', 'fill is not supported by this backend');
  }
  const point = requireResolvedPoint(resolved);
  const nodeType = 'node' in resolved ? (resolved.node?.type ?? '') : '';
  const isResolvedTextInput = nodeType !== '' && isFillableType(nodeType, runtime.backend.platform);
  const useMaestroNonHittableCoordinateFallback =
    options.allowNonHittableCoordinateFallback === true &&
    'node' in resolved &&
    resolved.node?.hittable === false;
  const backendResult = await runtime.backend.fill(
    toBackendContext(runtime, options),
    point,
    options.text,
    {
      delayMs: options.delayMs,
      allowNonHittableCoordinateFallback: useMaestroNonHittableCoordinateFallback,
    },
  );
  const formattedBackendResult = toBackendResult(backendResult);
  const warning =
    nodeType && !isResolvedTextInput
      ? `fill target ${formatTargetForWarning(resolved)} resolved to "${nodeType}", attempting fill anyway.`
      : undefined;
  return await applyPostActionObservation(
    runtime,
    options,
    resolved,
    {
      ...resolved,
      text: options.text,
      ...(warning ? { warning } : {}),
      ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    },
    observation,
  );
};

async function tapCommand(
  runtime: AgentDeviceRuntime,
  options: PressCommandOptions,
  action: 'click' | 'press',
): Promise<PressCommandResult> {
  if (options.refs?.length) {
    return await tapRefPlanCommand(runtime, options, action);
  }
  const observation = planPostActionObservation(options);
  const nativeRefTap = observation.needsPreActionBaseline
    ? null
    : await maybeTapRefTarget(runtime, options, action);
  if (nativeRefTap) return nativeRefTap;

  // One request object for the resolution and for the re-resolutions #3471's gate may spend, so the
  // second look is the same question asked again rather than a differently-configured one.
  const resolutionRequest: ResolveInteractionTargetParams = {
    action,
    requireInteractive: true,
    pipeline: SELECTOR_PIPELINE_POLICIES.promotedTarget,
    captureEvidenceBaseline: observation.needsPreActionBaseline,
    expectedResolvedTarget: options.expectedResolvedTarget,
    preresolvedTarget: options.preresolvedTarget,
  };
  const resolved = await resolveInteractionTarget(runtime, options, resolutionRequest);
  if (!runtime.backend.tap) {
    throw new AppError('UNSUPPORTED_OPERATION', 'tap is not supported by this backend');
  }
  const atRest = await admitResolvedTarget(runtime, options, resolutionRequest, resolved);
  const point = requireResolvedPoint(atRest);
  const pointObservation = pointObservationOf(atRest);
  let backendResult;
  try {
    backendResult = await runtime.backend.tap(toBackendContext(runtime, options), point, {
      button: options.button,
      count: options.count,
      intervalMs: options.intervalMs,
      holdMs: options.holdMs,
      jitterPx: options.jitterPx,
      doubleTap: options.doubleTap,
      ...(pointObservation ? { pointObservation } : {}),
    });
  } catch (error) {
    // Resolution is complete before the backend call. Preserve it out of
    // band so a daemon-level failure corroboration can still record the same
    // target identity if the backend reports an ambiguous tap outcome.
    attachResolvedInteractionTarget(error, atRest);
    throw error;
  }
  const formattedBackendResult = toBackendResult(backendResult);
  return await applyPostActionObservation(
    runtime,
    options,
    atRest,
    {
      ...atRest,
      ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    },
    observation,
  );
}

function requireResolvedPoint(result: { point?: Point }): Point {
  if (!result.point) {
    throw new AppError('COMMAND_FAILED', 'Interaction target resolved without coordinates');
  }
  return result.point;
}

/**
 * A multi-ref plan is one ADR 0014 logical command that resolves and admits every member
 * once against the active frame, then dispatches the admitted points in order — `press
 * --count` with N points. Key 1's dispatch expires the ref frame, so later keys tap where
 * the snapshot showed them: no member re-resolves, and the motion screen judges the whole
 * plan once, before key 1. Every resolution and admission refusal is pre-dispatch
 * (`dispatched: 'no'`); after key 1, the request dispatch ledger owns the dispatched-steps
 * disclosure and these details name the key that refused and the keys that did not run.
 */
async function tapRefPlanCommand(
  runtime: AgentDeviceRuntime,
  options: PressCommandOptions,
  action: 'click' | 'press',
): Promise<PressCommandResult> {
  if (options.target.kind !== 'ref') {
    throw new AppError('INVALID_ARGS', 'A multi-ref press plan requires ref targets.');
  }
  if (!runtime.backend.tap) {
    throw new AppError('UNSUPPORTED_OPERATION', 'tap is not supported by this backend');
  }
  // The parser emits the full plan in `refs` with `target` kept as member 0's
  // response identity, so the plan iterates `refs` alone.
  const plannedRefs = (options.refs ?? []).map((ref) => (ref.startsWith('@') ? ref : `@${ref}`));
  const observation = planPostActionObservation(options);
  const resolutionRequest: ResolveInteractionTargetParams = {
    action,
    requireInteractive: true,
    pipeline: SELECTOR_PIPELINE_POLICIES.promotedTarget,
  };
  const members: Array<{ ref: string; atRest: ResolvedInteractionTarget; point: Point }> = [];
  for (const [index, ref] of plannedRefs.entries()) {
    const member: PressCommandOptions = { ...options, target: { kind: 'ref', ref } };
    try {
      const resolved = await resolveInteractionTarget(runtime, member, {
        ...resolutionRequest,
        // One pre-command baseline serves the plan's evidence: member 0's resolution
        // captures it, and the final result carries it forward.
        captureEvidenceBaseline: observation.needsPreActionBaseline && index === 0,
      });
      const atRest = await admitResolvedTarget(runtime, member, resolutionRequest, resolved);
      members.push({ ref, atRest, point: requireResolvedPoint(atRest) });
    } catch (error) {
      // Nothing has crossed to the device yet.
      throw attachRefPlanContext(error, plannedRefs, index);
    }
  }
  let lastBackendResult;
  for (const [index, member] of members.entries()) {
    if (index > 0 && options.intervalMs !== undefined && options.intervalMs > 0) {
      await sleep(runtime, options.intervalMs, options.signal);
    }
    const pointObservation = pointObservationOf(member.atRest);
    try {
      lastBackendResult = await runtime.backend.tap(
        toBackendContext(runtime, options),
        member.point,
        {
          button: options.button,
          count: options.count,
          intervalMs: options.intervalMs,
          holdMs: options.holdMs,
          jitterPx: options.jitterPx,
          doubleTap: options.doubleTap,
          ...(pointObservation ? { pointObservation } : {}),
        },
      );
    } catch (error) {
      // Resolution is complete before the backend call. Preserve it out of
      // band so a daemon-level failure corroboration can still record the same
      // target identity if the backend reports an ambiguous tap outcome.
      attachResolvedInteractionTarget(error, member.atRest);
      throw attachRefPlanContext(error, plannedRefs, index);
    }
  }
  const last = members.at(-1)!;
  const first = members[0]!;
  // The plan's evidence compares the pre-command tree member 0 captured with the
  // post-command tree, so the baseline rides to the final result.
  const finalTarget: ResolvedInteractionTarget =
    last.atRest.preAction || !first.atRest.preAction
      ? last.atRest
      : { ...last.atRest, preAction: first.atRest.preAction };
  const formattedBackendResult = toBackendResult(lastBackendResult);
  const result = await applyPostActionObservation(
    runtime,
    options,
    finalTarget,
    {
      ...finalTarget,
      ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    },
    observation,
  );
  return {
    ...result,
    sequence: {
      pressed: members.length,
      refs: plannedRefs,
      points: members.map((member) => member.point),
    },
  };
}

function attachRefPlanContext(
  error: unknown,
  refs: readonly string[],
  failedIndex: number,
): unknown {
  if (!(error instanceof AppError)) return error;
  error.details = {
    ...error.details,
    refPlanKey: refs[failedIndex],
    refPlanPending: refs.slice(failedIndex + 1),
  };
  return error;
}

async function maybeTapRefTarget(
  runtime: AgentDeviceRuntime,
  options: PressCommandOptions,
  action: 'click' | 'press',
): Promise<PressCommandResult | null> {
  if (action !== 'click' || options.target.kind !== 'ref' || !runtime.backend.tapTarget) {
    return null;
  }
  if (hasNonDefaultTapOptions(options)) return null;
  // ADR 0012 step 4: a guarded replay action needs the runtime resolution
  // path so the post-resolution identity guard actually runs.
  if (options.expectedResolvedTarget) return null;
  // #1654 scope note: `preresolvedTarget` deliberately does NOT divert this
  // path. It is the separate ADR 0011 `native-ref` dispatch path, wired only
  // to the web provider's clickRef/fillRef (no mobile backend implements
  // tapTarget/fillTarget), where the ref IS the provider's own element handle.
  // Forcing a coordinate tap there to save a resolution would trade a working
  // provider-native dispatch for a worse one. The double-hop #1654 removes is
  // the runtime tree path below.
  // ADR 0011 native-ref preflight: the shared occlusion/offscreen guards run
  // against the stored session snapshot node before the backend call (a
  // backend fast path can silently "succeed", so errors must be raised here).
  // No snapshot / no usable rect → no-op; never adds a capture round trip.
  const { tapTarget } = runtime.backend;
  return await dispatchNativeRefInteraction(
    runtime,
    options,
    options.target,
    action,
    async (context, refTarget) => await tapTarget(context, refTarget),
  );
}

async function maybeFillRefTarget(
  runtime: AgentDeviceRuntime,
  options: FillCommandOptions,
): Promise<FillCommandResult | null> {
  if (options.target.kind !== 'ref' || !runtime.backend.fillTarget) return null;
  // ADR 0012 step 4: guarded replay actions take the runtime path — see maybeTapRefTarget.
  if (options.expectedResolvedTarget) return null;
  // ADR 0011 native-ref preflight — see maybeTapRefTarget.
  const { fillTarget } = runtime.backend;
  const dispatched = await dispatchNativeRefInteraction(
    runtime,
    options,
    options.target,
    'fill',
    async (context, refTarget) =>
      await fillTarget(context, refTarget, options.text, { delayMs: options.delayMs }),
  );
  return { ...dispatched, text: options.text };
}

function hasNonDefaultTapOptions(options: PressCommandOptions): boolean {
  return Boolean(
    options.count !== undefined ||
    options.intervalMs !== undefined ||
    options.holdMs !== undefined ||
    options.jitterPx !== undefined ||
    options.doubleTap !== undefined ||
    (options.button !== undefined && options.button !== 'primary'),
  );
}

function formatTargetForWarning(result: {
  kind: FillCommandResult['kind'];
  target?: ResolvedTarget;
}): string {
  if (result.target?.kind === 'ref') return result.target.ref;
  if (result.target?.kind === 'selector') return result.target.selector;
  return 'point';
}
