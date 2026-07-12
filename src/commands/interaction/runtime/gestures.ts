import { AppError } from '../../../kernel/errors.ts';
import type { Point } from '../../../kernel/snapshot.ts';
import type { ScrollDirection } from '../../../contracts/scroll-gesture.ts';
import {
  assertExclusiveScrollDistanceInputs,
  honoredScrollDurationMs,
  normalizeScrollDurationMs,
} from '../../../contracts/scroll-command.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { requireIntInRange } from '../../../utils/validation.ts';
import { successText } from '../../../utils/success-text.ts';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
  type ScrollEdge,
  type ScrollEdgeState,
  type ScrollEdgeTarget,
} from '../../../utils/scroll-edge-state.ts';
import { toBackendContext } from '../../runtime-common.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type BackendResultVariant,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import type { LongPressCommandResult } from '../../../contracts/interaction.ts';
import {
  assertSupportedInteractionSurface,
  type ExpectedResolvedTarget,
  type InteractionTarget,
  type ResolvedInteractionTarget,
  resolveInteractionTarget,
} from './resolution.ts';
import {
  applyPostActionObservation,
  planPostActionObservation,
  type SettlePostActionObservationOptions,
} from './post-action-observation.ts';

export type FocusCommandOptions = CommandContext & {
  target: InteractionTarget;
};

export type FocusCommandResult = ResolvedInteractionTarget & BackendResultEnvelope;

export type LongPressCommandOptions = CommandContext & {
  target: InteractionTarget;
  durationMs?: number;
  /** ADR 0012 step 4: replay-only post-resolution guard; see resolution.ts. */
  expectedResolvedTarget?: ExpectedResolvedTarget;
} & SettlePostActionObservationOptions;

export type { LongPressCommandResult };

export type GestureDirection = ScrollDirection;
export const SCROLL_INPUT_DIRECTIONS = ['up', 'down', 'left', 'right', 'top', 'bottom'] as const;
export type ScrollInputDirection = (typeof SCROLL_INPUT_DIRECTIONS)[number];

export type ScrollTarget =
  | InteractionTarget
  | {
      kind: 'viewport';
    };

export type ScrollCommandOptions = CommandContext & {
  target?: ScrollTarget;
  direction: ScrollInputDirection;
  amount?: number;
  pixels?: number;
  durationMs?: number;
};

export type ScrollCommandResult =
  | BackendResultVariant<{
      kind: 'viewport';
      direction: GestureDirection;
      edge?: 'top' | 'bottom';
      passes?: number;
      amount?: number;
      pixels?: number;
      durationMs?: number;
    }>
  | BackendResultVariant<
      ResolvedInteractionTarget & {
        direction: GestureDirection;
        edge?: 'top' | 'bottom';
        passes?: number;
        amount?: number;
        pixels?: number;
        durationMs?: number;
      }
    >;

type ResolvedScrollTarget = { kind: 'viewport' } | ResolvedInteractionTarget;

export const focusCommand: RuntimeCommand<FocusCommandOptions, FocusCommandResult> = async (
  runtime,
  options,
): Promise<FocusCommandResult> => {
  const resolved = await resolveInteractionTarget(runtime, options, {
    action: 'focus',
    requireInteractive: true,
    promoteToHittableAncestor: false,
  });
  if (!runtime.backend.focus) {
    throw new AppError('UNSUPPORTED_OPERATION', 'focus is not supported by this backend');
  }
  const point = requireResolvedPoint(resolved);
  const backendResult = await runtime.backend.focus(toBackendContext(runtime, options), point);
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    ...resolved,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Focused (${point.x}, ${point.y})`),
  };
};

export const longPressCommand: RuntimeCommand<
  LongPressCommandOptions,
  LongPressCommandResult
> = async (runtime, options): Promise<LongPressCommandResult> => {
  const observation = planPostActionObservation(options);
  const resolved = await resolveInteractionTarget(runtime, options, {
    action: 'longPress',
    requireInteractive: true,
    promoteToHittableAncestor: true,
    captureEvidenceBaseline: observation.needsPreActionBaseline,
    expectedResolvedTarget: options.expectedResolvedTarget,
  });
  if (!runtime.backend.longPress) {
    throw new AppError('UNSUPPORTED_OPERATION', 'longPress is not supported by this backend');
  }
  const durationMs =
    options.durationMs === undefined
      ? undefined
      : requireIntInRange(options.durationMs, 'durationMs', 0, 120_000);
  const point = requireResolvedPoint(resolved);
  const backendResult = await runtime.backend.longPress(toBackendContext(runtime, options), point, {
    durationMs,
  });
  const formattedBackendResult = toBackendResult(backendResult);
  return await applyPostActionObservation(
    runtime,
    options,
    resolved,
    {
      ...resolved,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
      ...successText(`Long pressed (${point.x}, ${point.y})`),
    },
    observation,
  );
};

export const scrollCommand: RuntimeCommand<ScrollCommandOptions, ScrollCommandResult> = async (
  runtime,
  options,
): Promise<ScrollCommandResult> => {
  if (!runtime.backend.scroll) {
    throw new AppError('UNSUPPORTED_OPERATION', 'scroll is not supported by this backend');
  }
  const target = resolveScrollDirection(options.direction);
  const amount = normalizeOptionalPositiveNumber(options.amount, 'scroll amount');
  const pixels = normalizeOptionalPositiveInteger(options.pixels, 'scroll pixels');
  const durationMs = normalizeScrollDurationMs(options.durationMs);
  assertExclusiveScrollDistanceInputs(
    { amount, pixels },
    'scroll accepts either amount or pixels, not both',
  );

  const resolved = await resolveScrollTarget(runtime, options);
  const backendTarget =
    resolved.kind === 'viewport'
      ? { kind: 'viewport' as const }
      : { kind: 'point' as const, point: requireResolvedPoint(resolved) };
  const scrollBackend = runtime.backend.scroll;
  const runScroll = async () =>
    await scrollBackend(toBackendContext(runtime, options), backendTarget, {
      direction: target.direction,
      ...(amount !== undefined ? { amount } : {}),
      ...(pixels !== undefined ? { pixels } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  let backendResult: Awaited<ReturnType<NonNullable<typeof runtime.backend.scroll>>> | undefined;
  let completedPasses = 0;
  if (target.edge) {
    const edge = target.edge;
    const edgeTarget = buildScrollEdgeTarget(resolved);
    const edgeResult = await runScrollEdgePasses({
      edge,
      captureState: async (scope) =>
        await captureRuntimeScrollEdgeState(runtime, options, edge, edgeTarget, scope),
      scroll: runScroll,
    });
    backendResult = edgeResult.result;
    completedPasses = edgeResult.passes;
  } else {
    backendResult = await runScroll();
    completedPasses = 1;
  }
  const formattedBackendResult = toBackendResult(backendResult);
  const reportedDurationMs = honoredScrollDurationMs(formattedBackendResult);
  return {
    ...resolved,
    direction: target.direction,
    ...(target.edge ? { edge: target.edge, passes: completedPasses } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(pixels !== undefined ? { pixels } : {}),
    ...(reportedDurationMs !== undefined ? { durationMs: reportedDurationMs } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(
      formatScrollEdgeMessage(target.direction, target.edge, completedPasses, amount, pixels),
    ),
  };
};

async function resolveScrollTarget(
  runtime: AgentDeviceRuntime,
  options: ScrollCommandOptions,
): Promise<ResolvedScrollTarget> {
  const target = options.target ?? { kind: 'viewport' as const };
  if (target.kind === 'viewport') {
    await assertSupportedInteractionSurface(runtime, options, 'scroll');
    return { kind: 'viewport' };
  }
  return await resolveInteractionTarget(
    runtime,
    { ...options, target },
    {
      action: 'scroll',
      requireInteractive: false,
      promoteToHittableAncestor: false,
    },
  );
}

function resolveScrollDirection(direction: ScrollInputDirection): {
  direction: GestureDirection;
  edge?: 'top' | 'bottom';
} {
  if (direction === 'bottom') return { direction: 'down', edge: 'bottom' };
  if (direction === 'top') return { direction: 'up', edge: 'top' };
  return { direction: requireDirection(direction, 'scroll direction') };
}

function buildScrollEdgeTarget(resolved: ResolvedScrollTarget): ScrollEdgeTarget {
  return resolved.kind === 'viewport'
    ? {}
    : {
        point: resolved.point,
        nodeIndex: 'node' in resolved ? resolved.node?.index : undefined,
      };
}

function requireResolvedPoint(result: { point?: Point }): Point {
  if (!result.point) {
    throw new AppError('COMMAND_FAILED', 'Interaction target resolved without coordinates');
  }
  return result.point;
}

async function captureRuntimeScrollEdgeState(
  runtime: AgentDeviceRuntime,
  options: ScrollCommandOptions,
  edge: ScrollEdge,
  target: ScrollEdgeTarget,
  scope?: string,
): Promise<ScrollEdgeState> {
  if (!runtime.backend.captureSnapshot) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `scroll ${edge} requires snapshot support to verify hidden content before scrolling`,
    );
  }
  const { captureSnapshot } = runtime.backend;
  return await captureScrollEdgeState({
    edge,
    target,
    scope,
    captureNodes: async (snapshotScope) => {
      const result = await captureSnapshot(toBackendContext(runtime, options), {
        scope: snapshotScope,
      });
      return result.snapshot?.nodes ?? result.nodes ?? [];
    },
  });
}

function requireDirection(
  direction: GestureDirection | undefined,
  field: string,
): GestureDirection {
  switch (direction) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return direction;
    default:
      throw new AppError('INVALID_ARGS', `${field} must be up, down, left, or right`);
  }
}

function normalizeOptionalPositiveNumber(
  value: number | undefined,
  field: string,
): number | undefined {
  return value === undefined ? undefined : normalizePositiveNumber(value, field);
}

function normalizePositiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('INVALID_ARGS', `${field} must be a positive number`);
  }
  return value;
}

function normalizeOptionalPositiveInteger(
  value: number | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new AppError('INVALID_ARGS', `${field} must be a positive integer`);
  }
  return value;
}
