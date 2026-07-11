import { AppError } from '../../../kernel/errors.ts';
import type { ClickButton } from '../../../core/click-button.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { isFillableType } from '../../../snapshot/snapshot-processing.ts';
import type { Point } from '../../../kernel/snapshot.ts';
import { requireIntInRange } from '../../../utils/validation.ts';
import { successText } from '../../../utils/success-text.ts';
import { findMistargetedTypeRefToken } from '../../../utils/type-target-warning.ts';
import type {
  FillCommandResult,
  PressCommandResult,
  ResolvedTarget,
} from '../../../contracts/interaction.ts';
import { toBackendContext } from '../../runtime-common.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import type { RepeatedInput } from '../../command-input.ts';
import {
  EXACT_REF_RESOLUTION,
  type ExpectedResolvedTarget,
  type InteractionTarget,
  preflightNativeRefInteraction,
  resolveInteractionTarget,
} from './resolution.ts';
import {
  applyPostActionObservation,
  planPostActionObservation,
  type PostActionObservationOptions,
} from './post-action-observation.ts';

export {
  focusCommand,
  longPressCommand,
  pinchCommand,
  scrollCommand,
  swipeCommand,
} from './gestures.ts';
export type {
  FocusCommandOptions,
  FocusCommandResult,
  GestureDirection,
  LongPressCommandOptions,
  LongPressCommandResult,
  PinchCommandOptions,
  PinchCommandResult,
  ScrollCommandOptions,
  ScrollCommandResult,
  ScrollTarget,
  SwipeCommandOptions,
  SwipeCommandResult,
  SwipeOptions,
} from './gestures.ts';
export type { InteractionTarget, PointTarget, ResolvedInteractionTarget } from './resolution.ts';

export type PressCommandOptions = CommandContext &
  RepeatedInput & {
    target: InteractionTarget;
    button?: ClickButton;
    /** ADR 0012 step 4: replay-only post-resolution guard; see resolution.ts. */
    expectedResolvedTarget?: ExpectedResolvedTarget;
  } & PostActionObservationOptions;

export type ClickCommandOptions = PressCommandOptions;

export type { FillCommandResult, PressCommandResult };

export type FillCommandOptions = CommandContext & {
  target: InteractionTarget;
  text: string;
  delayMs?: number;
  /** ADR 0012 step 4: replay-only post-resolution guard; see resolution.ts. */
  expectedResolvedTarget?: ExpectedResolvedTarget;
} & PostActionObservationOptions;

export type TypeTextCommandOptions = CommandContext & {
  text: string;
  delayMs?: number;
};

export type TypeTextCommandResult = {
  kind: 'text';
  text: string;
  delayMs: number;
} & BackendResultEnvelope;

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
    promoteToHittableAncestor: false,
    captureEvidenceBaseline: observation.needsPreActionBaseline,
    expectedResolvedTarget: options.expectedResolvedTarget,
  });
  if (!runtime.backend.fill) {
    throw new AppError('UNSUPPORTED_OPERATION', 'fill is not supported by this backend');
  }
  const point = requireResolvedPoint(resolved);
  const backendResult = await runtime.backend.fill(
    toBackendContext(runtime, options),
    point,
    options.text,
    { delayMs: options.delayMs },
  );
  const formattedBackendResult = toBackendResult(backendResult);
  const nodeType = 'node' in resolved ? (resolved.node?.type ?? '') : '';
  const warning =
    nodeType && !isFillableType(nodeType, runtime.backend.platform)
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

export const typeTextCommand: RuntimeCommand<
  TypeTextCommandOptions,
  TypeTextCommandResult
> = async (runtime, options): Promise<TypeTextCommandResult> => {
  const text = options.text;
  if (!text) throw new AppError('INVALID_ARGS', 'type requires text');
  const mistargetedRef = findMistargetedTypeRef(text);
  if (mistargetedRef) {
    throw new AppError(
      'INVALID_ARGS',
      `type does not accept a target ref like "${mistargetedRef}"`,
      {
        hint: `Use fill ${mistargetedRef} "text" to target that field, or press ${mistargetedRef} then type "text" to append.`,
      },
    );
  }
  if (!runtime.backend.typeText) {
    throw new AppError('UNSUPPORTED_OPERATION', 'type is not supported by this backend');
  }
  const delayMs = requireIntInRange(options.delayMs ?? 0, 'delay-ms', 0, 10_000);
  const backendResult = await runtime.backend.typeText(toBackendContext(runtime, options), text, {
    delayMs,
  });
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'text',
    text,
    delayMs,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Typed ${Array.from(text).length} chars`),
  };
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
    promoteToHittableAncestor: true,
    captureEvidenceBaseline: observation.needsPreActionBaseline,
    expectedResolvedTarget: options.expectedResolvedTarget,
  });
  if (!runtime.backend.tap) {
    throw new AppError('UNSUPPORTED_OPERATION', 'tap is not supported by this backend');
  }
  const point = requireResolvedPoint(resolved);
  const backendResult = await runtime.backend.tap(toBackendContext(runtime, options), point, {
    button: options.button,
    count: options.count,
    intervalMs: options.intervalMs,
    holdMs: options.holdMs,
    jitterPx: options.jitterPx,
    doubleTap: options.doubleTap,
  });
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
  // ADR 0011 native-ref preflight: the shared occlusion/offscreen guards run
  // against the stored session snapshot node before the backend call (a
  // backend fast path can silently "succeed", so errors must be raised here).
  // No snapshot / no usable rect → no-op; never adds a capture round trip.
  const preflight = await preflightNativeRefInteraction(runtime, options, options.target, action);
  const backendResult = await runtime.backend.tapTarget(toBackendContext(runtime, options), {
    kind: 'ref',
    ref: options.target.ref,
    ...(options.target.fallbackLabel ? { fallbackLabel: options.target.fallbackLabel } : {}),
  });
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'ref',
    target: { kind: 'ref', ref: options.target.ref },
    resolution: EXACT_REF_RESOLUTION,
    ...preflight,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
  };
}

async function maybeFillRefTarget(
  runtime: AgentDeviceRuntime,
  options: FillCommandOptions,
): Promise<FillCommandResult | null> {
  if (options.target.kind !== 'ref' || !runtime.backend.fillTarget) return null;
  // ADR 0012 step 4: guarded replay actions take the runtime path — see maybeTapRefTarget.
  if (options.expectedResolvedTarget) return null;
  // ADR 0011 native-ref preflight — see maybeTapRefTarget.
  const preflight = await preflightNativeRefInteraction(runtime, options, options.target, 'fill');
  const backendResult = await runtime.backend.fillTarget(
    toBackendContext(runtime, options),
    {
      kind: 'ref',
      ref: options.target.ref,
      ...(options.target.fallbackLabel ? { fallbackLabel: options.target.fallbackLabel } : {}),
    },
    options.text,
    { delayMs: options.delayMs },
  );
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'ref',
    target: { kind: 'ref', ref: options.target.ref },
    text: options.text,
    resolution: EXACT_REF_RESOLUTION,
    ...preflight,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
  };
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

function findMistargetedTypeRef(text: string): string | null {
  return findMistargetedTypeRefToken(text);
}
