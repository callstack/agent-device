import {
  assertExclusiveScrollDistanceInputs,
  honoredScrollDurationMs,
  normalizeScrollDurationMs,
  resolveScrollExecutionOptions,
  type ResolvedScrollExecutionOptions,
  type ScrollCommandOptions,
} from '@agent-device/contracts/scroll-command';
import { parseScrollDirection, type ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import {
  resolveScrollRuntimePlan,
  type ScrollRuntimePlan,
} from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { ScrollDirectionInput } from '@agent-device/contracts/scroll-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
  type ScrollEdge,
  type ScrollEdgeState,
} from '../snapshot/scroll-edge-state.ts';
import { withSuccessText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from './context.ts';
import { errorResponse } from './response.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

type ScrollTarget = Readonly<{
  direction: ScrollDirection;
  edge?: ScrollEdge;
}>;

/**
 * Both bindings come straight from the declared uses, so neither restates what a use already says:
 * an ordinary scroll cannot name a capture, and an edge scroll's `captureSnapshot` is non-optional
 * because `scrollEdgeUse` requires it.
 */
type BoundScrollDirection = BoundDeviceRuntime<
  Extract<ScrollRuntimePlan, { kind: 'direction' }>['use']
>;
type BoundScrollEdge = BoundDeviceRuntime<Extract<ScrollRuntimePlan, { kind: 'edge' }>['use']>;

/** `scroll bottom` scrolls down to the edge; `scroll top` scrolls up to it. */
function parseScrollTarget(input: string): ScrollTarget {
  if (input === 'bottom') return { direction: 'down', edge: 'bottom' };
  if (input === 'top') return { direction: 'up', edge: 'top' };
  return { direction: parseScrollDirection(input) };
}

function assertScrollCommandInputs(
  amount: number | undefined,
  pixels: number | undefined,
  durationMs: number | undefined,
): void {
  if (amount !== undefined && !Number.isFinite(amount)) {
    throw new AppError('INVALID_ARGS', 'scroll amount must be a number');
  }
  normalizeScrollDurationMs(durationMs);
  assertExclusiveScrollDistanceInputs({ amount, pixels });
}

/**
 * The one place `scroll` reaches a device (ADR 0019). Admission inspects the exact owner's
 * `scrollDirection` fact — plus `captureSnapshot` for an edge scroll, which cannot verify hidden
 * content without one — and binds once, before the dispatcher runs.
 *
 * The whole positional/flag parse happens here rather than inside the executor so an invalid
 * `scroll` is rejected exactly where the retired leaf rejected it: before any device work.
 */
export async function resolveBoundScrollRuntime(
  params: {
    device: DeviceInfo;
    positionals: readonly string[];
    context: DaemonCommandContext;
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const directionInput = params.positionals[0];
  const amount = params.positionals[1] ? Number(params.positionals[1]) : undefined;
  const pixels = params.context.pixels;
  const durationMs = params.context.durationMs;
  if (!directionInput) throw new AppError('INVALID_ARGS', 'scroll requires direction');
  assertScrollCommandInputs(amount, pixels, durationMs);

  const target = parseScrollTarget(directionInput);
  const options = resolveScrollExecutionOptions({ amount, pixels, durationMs }, target.edge);
  const plan = resolveScrollRuntimePlan(target.edge === undefined ? {} : { edge: target.edge });
  const admission = {
    command: 'scroll',
    device: params.device,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  };
  switch (plan.kind) {
    case 'direction':
      return await resolveBoundGenericRuntime(
        { ...admission, use: plan.use },
        async (runtime, dispatchContext) =>
          await executeDirectionScroll(runtime, target, options, dispatchContext),
      );
    case 'edge': {
      const edge = plan.edge;
      return await resolveBoundGenericRuntime(
        {
          ...admission,
          // The retired leaf refused an unsupported edge scroll by naming what the edge needs, so
          // the capture requirement keeps saying so rather than collapsing into "not supported".
          unavailableResponse: (unavailable) => scrollEdgeUnsupported(edge, unavailable.hint),
          use: plan.use,
        },
        async (runtime, dispatchContext) =>
          await executeEdgeScroll(runtime, edge, target, options, dispatchContext),
      );
    }
  }
}

function scrollEdgeUnsupported(edge: ScrollEdge, hint: string | undefined) {
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    `scroll ${edge} requires snapshot support to verify hidden content before scrolling`,
    undefined,
    hint === undefined ? undefined : { hint },
  );
}

/** One pass. This binding carries no capture, so an edge-style read will not type-check here. */
async function executeDirectionScroll(
  runtime: BoundScrollDirection,
  target: ScrollTarget,
  options: ResolvedScrollExecutionOptions,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  return scrollResult(
    target,
    options,
    1,
    (await scrollOnce(runtime, target, options, context)) ?? {},
  );
}

/** Repeats the pass while the verified state still moves; the capture needs no guard here. */
async function executeEdgeScroll(
  runtime: BoundScrollEdge,
  edge: ScrollEdge,
  target: ScrollTarget,
  options: ResolvedScrollExecutionOptions,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const edgeResult = await runScrollEdgePasses({
    edge,
    captureState: async (scope) => await captureEdgeState(runtime, edge, scope, context),
    scroll: async () => await scrollOnce(runtime, target, options, context),
  });
  return scrollResult(target, options, edgeResult.passes, edgeResult.result ?? {});
}

async function captureEdgeState(
  runtime: BoundScrollEdge,
  edge: ScrollEdge,
  scope: string | undefined,
  context: DaemonCommandContext,
): Promise<ScrollEdgeState> {
  return await captureScrollEdgeState({
    edge,
    scope,
    captureNodes: async (snapshotScope) =>
      (
        await runtime.operations.captureSnapshot({
          options: {
            ...(context.appBundleId === undefined ? {} : { appBundleId: context.appBundleId }),
            scope: snapshotScope,
          },
          execution: runtimeExecutionFromContext(context),
        })
      ).nodes ?? [],
  });
}

/** The single lexical owner of the bound call (R53); the edge binding satisfies this shape too. */
async function scrollOnce(
  runtime: BoundScrollDirection,
  target: ScrollTarget,
  options: ResolvedScrollExecutionOptions,
  context: DaemonCommandContext,
): Promise<Record<string, unknown> | void> {
  return await runtime.operations.scrollDirection(scrollInput(target.direction, options, context));
}

/** The one response shape both executors report. Owner fields win, as the retired leaf had them. */
function scrollResult(
  target: ScrollTarget,
  options: ScrollCommandOptions,
  completedPasses: number,
  interactionResult: Record<string, unknown>,
): Record<string, unknown> {
  const durationMs = honoredScrollDurationMs(interactionResult);
  return withSuccessText(
    {
      direction: target.direction,
      ...(target.edge ? { edge: target.edge, passes: completedPasses } : {}),
      ...(options.amount !== undefined ? { amount: options.amount } : {}),
      ...(options.pixels !== undefined ? { pixels: options.pixels } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...interactionResult,
    },
    formatScrollEdgeMessage(
      target.direction,
      target.edge,
      completedPasses,
      options.amount,
      options.pixels,
    ),
  );
}

/** The neutral intent one scroll carries, projected from a resolved command context. */
function scrollInput(
  direction: ScrollDirection,
  options: ResolvedScrollExecutionOptions,
  context: DaemonCommandContext,
): ScrollDirectionInput {
  return {
    direction,
    options,
    ...(context.appBundleId === undefined ? {} : { target: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}
