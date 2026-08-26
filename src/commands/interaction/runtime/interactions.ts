import type { ClickButton } from '@agent-device/contracts/click-button';
import type {
  FillCommandResult,
  PreresolvedInteractionTarget,
  PressCommandResult,
  RepeatedInput,
  ResolvedTarget,
} from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import { SELECTOR_PIPELINE_POLICIES } from '../../../core/selector-pipeline-policy.ts';
import type { Point } from '@agent-device/kernel/snapshot';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { isFillableType } from '@agent-device/contracts/snapshot';
import { attachResolvedInteractionTarget } from '../../../contracts/interaction-outcome.ts';
import { toBackendContext } from '../../runtime-common.ts';
import { toBackendResult, type RuntimeCommand } from '../../runtime-types.ts';
import {
  applyPostActionObservation,
  planPostActionObservation,
  type PostActionObservationOptions,
} from './post-action-observation.ts';
import {
  dispatchNativeRefInteraction,
  resolveInteractionTarget,
  type ExpectedResolvedTarget,
  type InteractionTarget,
} from './resolution.ts';

export { focusCommand, hoverCommand, longPressCommand, scrollCommand } from './gestures.ts';
export type {
  FocusCommandOptions,
  FocusCommandResult,
  HoverCommandOptions,
  HoverCommandResult,
  LongPressCommandOptions,
  LongPressCommandResult,
  ScrollCommandOptions,
  ScrollCommandResult,
} from './gestures.ts';
export type { InteractionTarget } from './resolution.ts';

export type PressCommandOptions = CommandContext &
  RepeatedInput & {
    target: InteractionTarget;
    button?: ClickButton;
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
  if (!options.text) throw new AppError('INVALID_ARGS', 'fill requires text');
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
  const observation = planPostActionObservation(options);
  const nativeRefTap = observation.needsPreActionBaseline
    ? null
    : await maybeTapRefTarget(runtime, options, action);
  if (nativeRefTap) return nativeRefTap;

  const resolved = await resolveInteractionTarget(runtime, options, {
    action,
    requireInteractive: true,
    pipeline: SELECTOR_PIPELINE_POLICIES.promotedTarget,
    captureEvidenceBaseline: observation.needsPreActionBaseline,
    expectedResolvedTarget: options.expectedResolvedTarget,
    preresolvedTarget: options.preresolvedTarget,
  });
  if (!runtime.backend.tap) {
    throw new AppError('UNSUPPORTED_OPERATION', 'tap is not supported by this backend');
  }
  const point = requireResolvedPoint(resolved);
  let backendResult;
  try {
    backendResult = await runtime.backend.tap(toBackendContext(runtime, options), point, {
      button: options.button,
      count: options.count,
      intervalMs: options.intervalMs,
      holdMs: options.holdMs,
      jitterPx: options.jitterPx,
      doubleTap: options.doubleTap,
    });
  } catch (error) {
    // Resolution is complete before the backend call. Preserve it out of
    // band so a daemon-level failure corroboration can still record the same
    // target identity if the backend reports an ambiguous tap outcome.
    attachResolvedInteractionTarget(error, resolved);
    throw error;
  }
  const formattedBackendResult = toBackendResult(backendResult);
  return await applyPostActionObservation(
    runtime,
    options,
    resolved,
    {
      ...resolved,
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
