import {
  assertExclusiveScrollDistanceInputs,
  assertScrollUntilCompatible,
  honoredScrollDurationMs,
  honoredScrollSwipeMidpoint,
  honoredScrollPixels,
  normalizeScrollDurationMs,
  resolveScrollExecutionOptions,
  type ResolvedScrollExecutionOptions,
  type ScrollCommandOptions,
  type ScrollMovementObservation,
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
import type { CommandFlags } from '@agent-device/contracts/command';
import { withSuccessText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from './context.ts';
import type { SessionState } from './session-state.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import {
  observeScrollMovement,
  planScrollMovement,
  reportScrollMovementNotApplicable,
  reportScrollMovementUnobserved,
  type ScrollMovementPlan,
  type ScrollSwipeEvidence,
} from './scroll-movement.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';
import type { CaptureSnapshotInput } from '@agent-device/contracts/snapshot-runtime';
import { errorResponse } from '@agent-device/kernel/contracts';

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
    /**
     * The live session and the caller's flags, both read before the dispatcher's side-effect seam can
     * expire the stored tree this command compares its own gesture against.
     */
    session: SessionState;
    flags: CommandFlags | undefined;
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
    case 'direction': {
      // Decided before the gesture, because this command's own scroll is what invalidates the tree it
      // compares against: the dispatcher expires the session's ref frame at its ADR 0014 side-effect
      // seam, and resolvers run before that seam. The same pre-effect freeze #1638's settle plan makes.
      const movementPlan = planScrollMovement({
        device: params.device,
        flags: params.flags,
        session: params.session,
      });
      return await resolveBoundGenericRuntime(
        { ...admission, use: plan.use },
        async (runtime, dispatchContext) =>
          await executeDirectionScroll(runtime, target, options, dispatchContext, movementPlan),
      );
    }
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

/**
 * One pass, and the observation that decides whether this response may name a distance (#2714).
 *
 * The baseline is the tree the session already holds, so a scroll that works costs one capture and
 * answers on it; only a surface that looks untouched keeps polling. Whether the read is owed at all was
 * already answered at resolve time by `planScrollMovement`; the one fact left is whether this binding
 * carries a capture.
 */
async function executeDirectionScroll(
  runtime: BoundScrollDirection,
  target: ScrollTarget,
  options: ResolvedScrollExecutionOptions,
  context: DaemonCommandContext,
  movementPlan: ScrollMovementPlan,
): Promise<Record<string, unknown>> {
  const interactionResult = (await scrollOnce(runtime, target, options, context)) ?? {};
  const movement = await directionalMovementClaim(
    runtime,
    target.direction,
    context,
    movementPlan,
    interactionResult,
  );
  return scrollResult(target, options, 1, interactionResult, movement);
}

/**
 * The movement this response may claim, or `undefined` when this command owed no observation of its own
 * effect at all. An absent `movement` field is a claim of its own, so every skip names a typed reason in
 * the daemon log; a runtime bound without a capture answers that way rather than `unobserved`, which
 * keeps its response exactly what it was before this observation existed.
 */
async function directionalMovementClaim(
  runtime: BoundScrollDirection,
  direction: ScrollDirection,
  context: DaemonCommandContext,
  movementPlan: ScrollMovementPlan,
  interactionResult: Record<string, unknown>,
): Promise<ScrollMovementObservation | undefined> {
  if (movementPlan.kind === 'declined') {
    reportScrollMovementNotApplicable(direction, movementPlan.reason);
    return undefined;
  }
  const capture = runtime.operations.captureSnapshot;
  if (!capture) {
    reportScrollMovementNotApplicable(direction, 'owner-without-capture');
    return undefined;
  }
  if (movementPlan.kind === 'unobservable') {
    // The read was owed and the evidence was not there. The answer says so rather than resting the
    // distance on a tree that predates something this command cannot see.
    return reportScrollMovementUnobserved(direction, movementPlan.reason, {
      swipe: swipeEvidence(interactionResult),
    });
  }
  return await observeScrollMovement({
    direction,
    baseline: movementPlan.baseline,
    swipe: swipeEvidence(interactionResult),
    capture: async () => await capture(scrollCaptureInput(context)),
  });
}

/**
 * The capture intent every scroll read shares: the session's app and the request's execution metadata,
 * and deliberately none of the caller's snapshot flags — a stop condition or a movement claim has to be
 * decided on the tree the platform answers by default, so `snapshot -i` on the same request cannot
 * change what this command reads.
 */
function scrollCaptureInput(
  context: DaemonCommandContext,
  scoped?: { scope: string | undefined },
): CaptureSnapshotInput {
  return {
    options: {
      ...(context.appBundleId === undefined ? {} : { appBundleId: context.appBundleId }),
      ...scoped,
    },
    execution: runtimeExecutionFromContext(context),
  };
}

/** What the leaf reported about the gesture it ran: where it ran, and how far it got. */
function swipeEvidence(result: Record<string, unknown>): ScrollSwipeEvidence {
  const midpoint = honoredScrollSwipeMidpoint(result);
  const pixels = honoredScrollPixels(result);
  return {
    ...(midpoint === undefined ? {} : { midpoint }),
    ...(pixels === undefined ? {} : { pixels }),
  };
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
          (await runtime.operations.captureSnapshot(scrollCaptureInput(context, { scope })))
            .nodes ?? [],
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
    capture: async () => await runtime.operations.captureSnapshot(scrollCaptureInput(context)),
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
        await runtime.operations.captureSnapshot(
          scrollCaptureInput(context, { scope: snapshotScope }),
        )
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
  movement?: ScrollMovementObservation,
): Record<string, unknown> {
  const durationMs = honoredScrollDurationMs(interactionResult);
  const honoredPixels = honoredScrollPixels(interactionResult);
  return withSuccessText(
    {
      direction: target.direction,
      ...(target.edge ? { edge: target.edge, passes: completedPasses } : {}),
      ...(options.amount !== undefined ? { amount: options.amount } : {}),
      ...(options.pixels !== undefined ? { pixels: options.pixels } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...interactionResult,
      // The observation is this command's own claim about its effect, so it is the one field the
      // owner answers with rather than echoes from the platform leaf.
      ...(movement === undefined ? {} : { movement }),
    },
    formatScrollEdgeMessage({
      direction: target.direction,
      edge: target.edge,
      passes: completedPasses,
      amount: options.amount,
      pixels: options.pixels,
      honoredPixels,
      ...(movement === undefined ? {} : { movement }),
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
