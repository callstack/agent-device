import {
  assertExclusiveScrollDistanceInputs,
  assertScrollUntilCompatible,
  honoredScrollDurationMs,
  honoredScrollPixels,
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
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
  scrollSurfaceFingerprint,
  type ScrollEdge,
  type ScrollEdgeState,
} from '@agent-device/capture-kit/scroll-edge-state';
import { formatScrollUntilMessage, runScrollUntilVisible } from './scroll-until.ts';
import { publicPlatformString } from '@agent-device/kernel/device';
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
type BoundScrollUntil = BoundDeviceRuntime<Extract<ScrollRuntimePlan, { kind: 'until' }>['use']>;

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
  const until = params.context.until;
  if (!directionInput) throw new AppError('INVALID_ARGS', 'scroll requires direction');
  assertScrollCommandInputs(amount, pixels, durationMs);

  const target = parseScrollTarget(directionInput);
  const stopCondition = {
    ...(target.edge === undefined ? {} : { edge: target.edge }),
    ...(until === undefined ? {} : { until }),
  };
  assertScrollUntilCompatible(stopCondition);
  const options = resolveScrollExecutionOptions({ amount, pixels, durationMs }, target.edge);
  const plan = resolveScrollRuntimePlan(stopCondition);
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
          unavailableResponse: (unavailable) =>
            scrollCaptureUnsupported(
              `scroll ${edge}, which verifies hidden content before scrolling,`,
              unavailable.hint,
            ),
          use: plan.use,
        },
        async (runtime, dispatchContext) =>
          await executeEdgeScroll(runtime, edge, target, options, dispatchContext),
      );
    }
    case 'until': {
      const selector = plan.until;
      return await resolveBoundGenericRuntime(
        {
          ...admission,
          unavailableResponse: (unavailable) =>
            scrollCaptureUnsupported(
              'scroll --until, which checks whether the selector became visible,',
              unavailable.hint,
            ),
          use: plan.use,
        },
        async (runtime, dispatchContext) =>
          await executeUntilScroll(
            runtime,
            params.device,
            selector,
            target,
            options,
            dispatchContext,
          ),
      );
    }
  }
}

/**
 * Both verifying tiers refuse the same way and differ only in what they would have checked, so the
 * refusal names that rather than collapsing into "not supported" — the shape the retired leaf had.
 */
function scrollCaptureUnsupported(subject: string, hint: string | undefined) {
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    `${subject} requires snapshot support`,
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
  // The loop discovers its scope from the first capture; the rest-wait has to watch the same
  // scoped container the loop decides on, so it reads the scope this closure records.
  let scope: string | undefined;
  const edgeResult = await runScrollEdgePasses({
    edge,
    captureState: async (stateScope) => {
      const state = await captureEdgeState(runtime, edge, stateScope, context);
      scope = state.scope ?? scope;
      return state;
    },
    scroll: async () => await scrollOnce(runtime, target, options, context),
    settleAfterPass: async () => {
      await pollForScrollRest(
        async () =>
          (
            await runtime.operations.captureSnapshot({
              options: {
                ...(context.appBundleId === undefined ? {} : { appBundleId: context.appBundleId }),
                scope,
              },
              execution: runtimeExecutionFromContext(context),
            })
          ).nodes ?? [],
        edge,
      );
    },
  });
  return scrollResult(target, options, edgeResult.passes, edgeResult.result ?? {});
}

/** Repeats the pass until the selector is on screen; every failure shape is owned by the loop. */
async function executeUntilScroll(
  runtime: BoundScrollUntil,
  device: DeviceInfo,
  selector: string,
  target: ScrollTarget,
  options: ResolvedScrollExecutionOptions,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const untilResult = await runScrollUntilVisible({
    selector,
    direction: target.direction,
    platform: publicPlatformString(device),
    capture: async () =>
      await runtime.operations.captureSnapshot({
        options: context.appBundleId === undefined ? {} : { appBundleId: context.appBundleId },
        execution: runtimeExecutionFromContext(context),
      }),
    scroll: async () => await scrollOnce(runtime, target, options, context),
  });
  return withSuccessText(
    {
      direction: target.direction,
      until: selector,
      passes: untilResult.passes,
      ...(options.amount !== undefined ? { amount: options.amount } : {}),
      ...(options.pixels !== undefined ? { pixels: options.pixels } : {}),
      ...(untilResult.result ?? {}),
    },
    formatScrollUntilMessage(target.direction, selector, untilResult.passes),
  );
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

const SCROLL_REST_TIMEOUT_MS = 1200;
const SCROLL_REST_POLL_MS = 120;

/**
 * Wait for the last fling to come to rest before the loop decides or flings again. A rubber-band
 * bounce keeps shifting the surface for a beat after a fling; deciding or re-scrolling mid-bounce
 * reads a phantom new state and stacks another fling on top, which is how one stuck scroll becomes a
 * runaway bounce. Two consecutive captures with the same surface fingerprint means the content is at
 * rest. Bounded, so a never-settling animation cannot hang a pass.
 */
async function pollForScrollRest(
  captureNodes: () => Promise<readonly (RawSnapshotNode | SnapshotNode)[]>,
  edge: ScrollEdge,
  timeoutMs = SCROLL_REST_TIMEOUT_MS,
  pollMs = SCROLL_REST_POLL_MS,
): Promise<void> {
  let previous: string | undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fingerprint = await scrollSurfaceFingerprint(await captureNodes(), edge);
    if (fingerprint === previous) return;
    previous = fingerprint;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
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
    formatScrollEdgeMessage({
      direction: target.direction,
      edge: target.edge,
      passes: completedPasses,
      amount: options.amount,
      pixels: options.pixels,
      honoredPixels: honoredScrollPixels(interactionResult),
    }),
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
