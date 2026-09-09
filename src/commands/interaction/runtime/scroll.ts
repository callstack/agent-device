import {
  assertExclusiveScrollDistanceInputs,
  honoredScrollDurationMs,
  normalizeScrollDurationMs,
  resolveScrollExecutionOptions,
} from '@agent-device/contracts/scroll-command';
import type { ScrollDirection, ScrollInputDirection } from '@agent-device/contracts/scroll-gesture';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
  type ScrollEdge,
  type ScrollEdgeState,
  type ScrollEdgeTarget,
} from '@agent-device/capture-kit/scroll-edge-state';
import { AppError } from '@agent-device/kernel/errors';
import { successText } from '@agent-device/kernel/success-text';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { toBackendContext } from '../../runtime-common.ts';
import {
  toBackendResult,
  type BackendResultVariant,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import { requireResolvedPoint } from './gestures.ts';
import {
  assertSupportedInteractionSurface,
  resolveInteractionTarget,
  type InteractionTarget,
  type ResolvedInteractionTarget,
} from './resolution.ts';

export type GestureDirection = ScrollDirection;
// The input vocabulary lives in contracts/scroll-gesture.ts beside the other scroll vocabularies,
// so the public API can declare `ScrollOptions` without depending on this command runtime.
export { type ScrollInputDirection } from '@agent-device/contracts/scroll-gesture';

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
  const executionOptions = resolveScrollExecutionOptions(
    {
      ...(amount !== undefined ? { amount } : {}),
      ...(pixels !== undefined ? { pixels } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
    target.edge,
  );
  const runScroll = async () =>
    await scrollBackend(toBackendContext(runtime, options), backendTarget, {
      direction: target.direction,
      ...executionOptions,
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
      pipeline: SELECTOR_PIPELINE_POLICIES.resolvedTarget,
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
