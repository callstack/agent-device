import {
  assertExclusiveScrollDistanceInputs,
  assertScrollUntilCompatible,
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
import {
  formatScrollUntilMessage,
  runScrollUntilVisiblePasses,
  scrollUntilNotFoundError,
} from '@agent-device/capture-kit/scroll-until-visible';
import { isSelectorVisibleInNodes } from '@agent-device/selectors/scroll-until-match';
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
  /** Repeat passes until this selector is visible on screen, then stop. */
  until?: string;
};

export type ScrollCommandResult =
  | BackendResultVariant<{
      kind: 'viewport';
      direction: GestureDirection;
      edge?: 'top' | 'bottom';
      until?: string;
      passes?: number;
      amount?: number;
      pixels?: number;
      durationMs?: number;
    }>
  | BackendResultVariant<
      ResolvedInteractionTarget & {
        direction: GestureDirection;
        edge?: 'top' | 'bottom';
        until?: string;
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
  const distance = normalizeScrollDistance(options, target.edge);
  const resolved = await resolveScrollTarget(runtime, options);
  const runScroll = bindScrollPass(
    runtime,
    options,
    resolved,
    target.direction,
    distance.execution,
  );

  if (options.until !== undefined) {
    return await runUntilScroll({
      runtime,
      options,
      resolved,
      direction: target.direction,
      until: options.until,
      distance: distance.reported,
      scroll: runScroll,
    });
  }
  return await runDirectionOrEdgeScroll({
    runtime,
    options,
    resolved,
    target,
    distance,
    scroll: runScroll,
  });
};

type NormalizedScrollDistance = {
  /** What the caller asked for, echoed back on the result. */
  reported: { amount?: number; pixels?: number };
  execution: ReturnType<typeof resolveScrollExecutionOptions>;
};

/** Every distance/timing rejection, in one place, before any target resolution or device work. */
function normalizeScrollDistance(
  options: ScrollCommandOptions,
  edge: ScrollEdge | undefined,
): NormalizedScrollDistance {
  assertScrollUntilCompatible({
    ...(edge ? { edge } : {}),
    ...(options.until === undefined ? {} : { until: options.until }),
  });
  const amount = normalizeOptionalPositiveNumber(options.amount, 'scroll amount');
  const pixels = normalizeOptionalPositiveInteger(options.pixels, 'scroll pixels');
  const durationMs = normalizeScrollDurationMs(options.durationMs);
  assertExclusiveScrollDistanceInputs(
    { amount, pixels },
    'scroll accepts either amount or pixels, not both',
  );
  const reported = {
    ...(amount !== undefined ? { amount } : {}),
    ...(pixels !== undefined ? { pixels } : {}),
  };
  return {
    reported,
    execution: resolveScrollExecutionOptions(
      { ...reported, ...(durationMs !== undefined ? { durationMs } : {}) },
      edge,
    ),
  };
}

/** One pass, with its target and options already resolved: the unit every branch repeats. */
function bindScrollPass(
  runtime: AgentDeviceRuntime,
  options: ScrollCommandOptions,
  resolved: ResolvedScrollTarget,
  direction: GestureDirection,
  execution: ReturnType<typeof resolveScrollExecutionOptions>,
): () => Promise<Awaited<ReturnType<NonNullable<AgentDeviceRuntime['backend']['scroll']>>>> {
  const scrollBackend = runtime.backend.scroll;
  if (!scrollBackend) {
    throw new AppError('UNSUPPORTED_OPERATION', 'scroll is not supported by this backend');
  }
  const backendTarget =
    resolved.kind === 'viewport'
      ? { kind: 'viewport' as const }
      : { kind: 'point' as const, point: requireResolvedPoint(resolved) };
  return async () =>
    await scrollBackend(toBackendContext(runtime, options), backendTarget, {
      direction,
      ...execution,
    });
}

/** `scroll <direction>` and `scroll top|bottom`: one pass, or passes until the edge stops moving. */
async function runDirectionOrEdgeScroll(params: {
  runtime: AgentDeviceRuntime;
  options: ScrollCommandOptions;
  resolved: ResolvedScrollTarget;
  target: { direction: GestureDirection; edge?: ScrollEdge };
  distance: NormalizedScrollDistance;
  scroll: () => Promise<Awaited<ReturnType<NonNullable<AgentDeviceRuntime['backend']['scroll']>>>>;
}): Promise<ScrollCommandResult> {
  const { runtime, options, resolved, target, distance } = params;
  const edge = target.edge;
  const pass = edge
    ? await runScrollEdgePasses({
        edge,
        captureState: async (scope) =>
          await captureRuntimeScrollEdgeState(
            runtime,
            options,
            edge,
            buildScrollEdgeTarget(resolved),
            scope,
          ),
        scroll: params.scroll,
      })
    : { passes: 1, result: await params.scroll() };
  const backendResult = toBackendResult(pass.result);
  const reportedDurationMs = honoredScrollDurationMs(backendResult);
  return {
    ...resolved,
    direction: target.direction,
    ...(edge ? { edge, passes: pass.passes } : {}),
    ...distance.reported,
    ...(reportedDurationMs !== undefined ? { durationMs: reportedDurationMs } : {}),
    ...(backendResult ? { backendResult } : {}),
    ...successText(
      formatScrollEdgeMessage(
        target.direction,
        edge,
        pass.passes,
        distance.reported.amount,
        distance.reported.pixels,
        honoredScrollPixels(backendResult),
      ),
    ),
  };
}

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

/**
 * `scroll --until <selector>`: repeat the pass until the selector is on screen.
 *
 * A sibling of the edge branch rather than a variant of the one-pass branch — it owns a different
 * stop condition, a different failure vocabulary, and a result that names the selector it stopped
 * on, none of which the ordinary scroll result carries.
 */
async function runUntilScroll(params: {
  runtime: AgentDeviceRuntime;
  options: ScrollCommandOptions;
  resolved: ResolvedScrollTarget;
  direction: GestureDirection;
  until: string;
  distance: { amount?: number; pixels?: number };
  scroll: () => Promise<Awaited<ReturnType<NonNullable<AgentDeviceRuntime['backend']['scroll']>>>>;
}): Promise<ScrollCommandResult> {
  const { runtime, options, resolved, direction, until, distance } = params;
  const edge = verticalEdgeFor(direction);
  const result = await runScrollUntilVisiblePasses({
    ...(edge === undefined ? {} : { edge }),
    captureNodes: async () => await captureRuntimeScrollNodes(runtime, options),
    isVisibleMatch: async (nodes) =>
      await isSelectorVisibleInNodes({
        nodes,
        selector: until,
        platform: runtime.backend.platform,
      }),
    scroll: params.scroll,
  });
  if (result.outcome !== 'matched') {
    throw scrollUntilNotFoundError({
      direction,
      selector: until,
      outcome: result.outcome,
      passes: result.passes,
    });
  }
  const backendResult = toBackendResult(result.result);
  return {
    ...resolved,
    direction,
    until,
    passes: result.passes,
    ...distance,
    ...(backendResult ? { backendResult } : {}),
    ...successText(formatScrollUntilMessage(direction, until, result.passes)),
  };
}

/** The travel the planner produced, which saturates below a large requested amount. */
function honoredScrollPixels(result: Record<string, unknown> | undefined): number | undefined {
  return typeof result?.pixels === 'number' ? result.pixels : undefined;
}

/**
 * The end-of-content analyzer only reads vertical edges, so a horizontal `--until` is bounded by
 * its pass budget alone rather than by a signal that would always report "no room".
 */
function verticalEdgeFor(direction: GestureDirection): ScrollEdge | undefined {
  if (direction === 'down') return 'bottom';
  if (direction === 'up') return 'top';
  return undefined;
}

async function captureRuntimeScrollNodes(
  runtime: AgentDeviceRuntime,
  options: ScrollCommandOptions,
) {
  if (!runtime.backend.captureSnapshot) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'scroll --until requires snapshot support to check whether the selector became visible',
    );
  }
  const result = await runtime.backend.captureSnapshot(toBackendContext(runtime, options), {
    includeRects: true,
  });
  return result.snapshot?.nodes ?? result.nodes ?? [];
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
