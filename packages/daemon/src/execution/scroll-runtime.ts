import { sleep } from '@agent-device/host-kit/retry';
import {
  assertExclusiveScrollDistanceInputs,
  assertScrollRefreshCompatible,
  assertScrollUntilCompatible,
  DEFAULT_REFRESH_PULL_DURATION_MS,
  normalizeScrollDurationMs,
  resolveScrollExecutionOptions,
  type ResolvedScrollExecutionOptions,
  type ScrollCommandOptions,
  type ScrollMovementObservation,
} from '@agent-device/contracts/scroll-command';
import type { GestureViewportInput } from '@agent-device/contracts/gesture-runtime';
import {
  assertScrollGestureInput,
  buildPullRefreshGesturePlan,
  DEFAULT_REFRESH_PULL_AMOUNT,
  inferGestureViewportRect,
  parseScrollDirection,
  REFRESH_PULL_MAX_PX,
  REFRESH_PULL_MIN_PX,
  type ScrollDirection,
} from '@agent-device/contracts/scroll-gesture';
import type {
  BoundDeviceRuntime,
  RuntimeOperationKey,
} from '@agent-device/contracts/platform-runtime';
import {
  resolveScrollRuntimePlan,
  type PlatformRuntimeOperations,
  type ScrollRuntimePlan,
} from '@agent-device/contracts/platform-runtime-operations';
import type {
  ScrollDirectionInput,
  ScrollDirectionResult,
} from '@agent-device/contracts/scroll-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RawSnapshotNode, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  readScrollPullContainer,
  runScrollEdgePasses,
  scrollSurfaceFingerprint,
  type ScrollEdge,
  type ScrollEdgeObservation,
  type ScrollEdgeState,
} from '@agent-device/capture-kit/scroll-edge-state';
import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import {
  formatScrollUntilMessage,
  runScrollUntilVisible,
  scrollCaptureRefusal,
} from './scroll-until.ts';
import { publicPlatformString } from '@agent-device/kernel/device';
import type { CommandFlags } from '@agent-device/contracts/command';
import { withSuccessText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from '../core/context.ts';
import type { SessionState } from '../core/session-state.ts';
import type { ResolvedGenericExecution } from '../core/generic-leaf-execution.ts';
import {
  resolveBoundGenericRuntime,
  type RuntimeAdmissionBindings,
} from '../core/runtime-admission.ts';
import {
  observeScrollMovement,
  planScrollMovement,
  readScrollTargetContainer,
  reportScrollMovementNotApplicable,
  reportScrollMovementUnobserved,
  type ScrollMovementPlan,
} from './scroll-movement.ts';
import { runtimeExecutionFromContext } from '../core/snapshot-runtime-capture-input.ts';
import type { CaptureSnapshotInput } from '@agent-device/contracts/snapshot-runtime';
import { errorResponse } from '@agent-device/kernel/contracts';

type ScrollTarget = Readonly<{
  direction: ScrollDirection;
  edge?: ScrollEdge;
  refresh?: boolean;
}>;

/**
 * Both bindings come straight from the declared uses, so neither restates what a use already says:
 * an ordinary scroll cannot name a capture, while an edge scroll's and a refresh pull's
 * `captureSnapshot` are non-optional because their uses require them.
 */
type BoundScrollDirection = BoundDeviceRuntime<
  Extract<ScrollRuntimePlan, { kind: 'direction' }>['use']
>;
type BoundScrollRefresh = BoundDeviceRuntime<
  Extract<ScrollRuntimePlan, { kind: 'refresh' }>['use']
>;
type BoundScrollEdge = BoundDeviceRuntime<Extract<ScrollRuntimePlan, { kind: 'edge' }>['use']>;
type BoundScrollUntil = BoundDeviceRuntime<Extract<ScrollRuntimePlan, { kind: 'until' }>['use']>;

/** `scroll bottom` scrolls down to the edge; `scroll top` scrolls up to it; `scroll refresh` pulls down at the top edge. */
function parseScrollTarget(input: string): ScrollTarget {
  if (input === 'bottom') return { direction: 'down', edge: 'bottom' };
  if (input === 'top') return { direction: 'up', edge: 'top' };
  if (input === 'refresh') return { direction: 'up', refresh: true };
  return { direction: parseScrollDirection(input) };
}

function assertScrollCommandInputs(
  amount: number | undefined,
  pixels: number | undefined,
  durationMs: number | undefined,
  refresh: boolean,
): void {
  if (amount !== undefined && !Number.isFinite(amount)) {
    throw new AppError('INVALID_ARGS', 'scroll amount must be a number');
  }
  normalizeScrollDurationMs(durationMs);
  assertExclusiveScrollDistanceInputs({ amount, pixels });
  // A pull is planned from these, so the same non-positive rule the pull planner enforces is
  // answered here, before admission, the capture, or the gesture.
  if (refresh) assertScrollGestureInput({ amount, pixels });
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
  const target = parseScrollTarget(directionInput);
  assertScrollCommandInputs(amount, pixels, durationMs, target.refresh === true);

  const stopCondition = {
    ...(target.edge === undefined ? {} : { edge: target.edge }),
    ...(until === undefined ? {} : { until }),
    ...(params.context.maxPasses === undefined ? {} : { maxPasses: params.context.maxPasses }),
    ...(target.refresh === true ? { refresh: true } : {}),
  };
  assertScrollUntilCompatible(stopCondition);
  assertScrollRefreshCompatible(stopCondition);
  const options = resolveScrollExecutionOptions({ amount, pixels, durationMs }, target.edge);
  const plan = resolveScrollRuntimePlan(stopCondition);
  const admission = {
    command: 'scroll',
    device: params.device,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  };
  switch (plan.kind) {
    case 'refresh': {
      const movementPlan = planScrollMovement({
        device: params.device,
        flags: params.flags,
        session: params.session,
      });
      return await resolveBoundGenericRuntime(
        {
          ...admission,
          // Each requirement the use mixes names its own refusal: the touch-scroll fact for a
          // surface no finger pulls, the capture for a leaf that cannot read the screen, and the
          // pan for a leaf that plans no gesture. None of them collapses into "requires snapshot".
          unavailableResponse: (unavailable, operation) =>
            refreshAdmissionRefusal(params.device, operation, unavailable.hint),
          use: plan.use,
        },
        async (runtime, dispatchContext) => {
          // The refusal and the container both come from a fresh capture read before the gesture:
          // the pull is what invalidates the tree, and the session's stored tree may already be
          // stale from an earlier one (ADR 0014), so the stored snapshot cannot answer here.
          const { state: topState, nodes } = await readCapturedTopEdgeState(
            runtime,
            dispatchContext,
          );
          if (topState.containerRect === undefined) {
            throw new AppError(
              'COMMAND_FAILED',
              'scroll refresh found no scrollable container at the top of the screen',
              {
                reason: 'scroll_refresh_no_container',
                hint: 'The surface names no vertical scroll container, so there is nothing to pull. Scroll with a direction if the content should move.',
              },
            );
          }
          if (topState.canScroll) {
            throw new AppError(
              'COMMAND_FAILED',
              'scroll refresh refused: the scrollable area still has hidden content above, so it is not at the top',
              {
                reason: 'scroll_refresh_not_at_top',
                containerRect: topState.containerRect,
                hint: 'Run scroll top, then scroll refresh.',
              },
            );
          }
          // The pull stays on the container's VISIBLE band, which an ancestor may cut shorter than
          // the container's own frame; a touch outside it never reaches the list.
          const pullBounds = topState.pullRect ?? topState.containerRect;
          const refreshOptions = resolveRefreshExecutionOptions(
            { amount, pixels, durationMs },
            pullBounds,
          );
          const pull = await performRefreshPull(
            runtime,
            refreshOptions,
            pullBounds,
            nodes,
            dispatchContext,
          );
          const observed = await directionalMovementClaim(
            runtime,
            target.direction,
            dispatchContext,
            movementPlan,
            pull,
          );
          // A refresh pull runs at the top edge by construction, so `at-edge` is not news to report
          // back: an unchanged surface is answered as `unchanged`, never as "nothing to scroll".
          const movement = observed === 'at-edge' ? 'unchanged' : observed;
          return scrollResult(target, refreshOptions, 1, pull, movement);
        },
      );
    }
    case 'direction': {
      // Decided before the gesture, because this command's own scroll is what invalidates the tree it
      // compares against: the dispatcher expires the session's ref frame at its ADR 0014 side-effect
      // seam, and resolvers run before that seam. The same pre-effect freeze #1638's settle plan makes.
      const movementPlan = planScrollMovement({
        device: params.device,
        flags: params.flags,
        session: params.session,
      });
      const containerRect = await readScrollTargetContainer(
        params.device,
        params.session,
        target.direction,
      );
      const directionOptions =
        containerRect === undefined ? options : { ...options, containerRect };
      return await resolveBoundGenericRuntime(
        { ...admission, use: plan.use },
        async (runtime, dispatchContext) =>
          await executeDirectionScroll(
            runtime,
            target,
            directionOptions,
            dispatchContext,
            movementPlan,
          ),
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
 * The refusal one refresh requirement answers, named for the cell that failed. The refresh use
 * mixes a capability fact with two execution operations, so a leaf that runs gestures but cannot
 * read the screen, or reads the screen but plans no gesture, must not be told it lacks snapshot
 * support. Every branch carries the typed reason an agent branches on.
 */
function refreshAdmissionRefusal(
  device: DeviceInfo,
  operation: RuntimeOperationKey<PlatformRuntimeOperations>,
  hint: string | undefined,
) {
  const withHint = hint === undefined ? undefined : { hint };
  if (operation === 'touchScrollSurface') {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      `scroll refresh is not supported on ${publicPlatformString(device)}: it needs a touch scroll surface`,
      { reason: 'scroll_refresh_unsupported_platform' },
      withHint,
    );
  }
  if (operation === 'performGesturePlan') {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      `scroll refresh is not supported on ${publicPlatformString(device)}: it dispatches the pull as a gesture plan`,
      { reason: 'scroll_refresh_unsupported_platform' },
      withHint,
    );
  }
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    `scroll refresh is not supported on ${publicPlatformString(device)}: it reads the top edge of the scrollable area before pulling, which requires snapshot support`,
    { reason: 'scroll_refresh_unsupported_platform' },
    withHint,
  );
}

/**
 * The execution options one pull-to-refresh carries: a slow pull (a fast one reads as a fling and
 * rubber-bands back without committing the refresh control) whose distance defaults to a fraction
 * of the container height and is clamped into the measured-safe band — small pulls only
 * rubber-band (0/5 below ~300px on an iOS RN list) while large ones stay reliable. The pull
 * itself is planned top-anchored by `buildPullRefreshGesturePlan` and dispatched as one pan, so
 * no hold rides in these options: a holdMs-0 run committed the refresh 5/5 on both platforms.
 */
function resolveRefreshExecutionOptions(
  options: ScrollCommandOptions,
  visibleContainer: Rect,
): ResolvedScrollExecutionOptions {
  const pullAmount = options.amount ?? DEFAULT_REFRESH_PULL_AMOUNT;
  // The pull distance always lands in the measured-safe band, whether it came from an explicit
  // --pixels or from the container fraction: small pulls only rubber-band, large ones stay reliable.
  const pullPixels = Math.min(
    REFRESH_PULL_MAX_PX,
    Math.max(
      REFRESH_PULL_MIN_PX,
      options.pixels ?? Math.round(pullAmount * visibleContainer.height),
    ),
  );
  return {
    ...(options.amount !== undefined ? { amount: options.amount } : {}),
    pixels: pullPixels,
    durationMs: options.durationMs ?? DEFAULT_REFRESH_PULL_DURATION_MS,
    releaseBehavior: 'controlled',
  };
}

/**
 * The one pull `scroll refresh` dispatches: the top-anchored lane computed once in TypeScript
 * against the resolved container, lowered to a single-contact pan and sent through the bound
 * gesture plan operation — the same path `gesture pan` takes, with the slow duration and no hold.
 * The plan's coordinates are absolute in the capture's screen-origin space, and the plan carries
 * its viewport, so the runner maps them onto the app window itself (a split-view iPad's
 * non-zero window origin included).
 */
async function performRefreshPull(
  runtime: BoundScrollRefresh,
  options: ResolvedScrollExecutionOptions,
  visibleContainer: Rect,
  nodes: readonly (RawSnapshotNode | SnapshotNode)[],
  context: DaemonCommandContext,
): Promise<ScrollDirectionResult> {
  const viewport = await refreshGestureViewport(runtime, nodes, context);
  const pull = buildPullRefreshGesturePlan({
    ...(options.amount !== undefined ? { amount: options.amount } : {}),
    pixels: options.pixels,
    container: visibleContainer,
    viewport,
  });
  // The planner keeps the lane inside the visible band, so one shorter than the measured-safe floor
  // cannot carry a pull that commits (0/5 below ~300px on an iOS RN list). Dispatching it would
  // report a refresh the pull provably cannot trigger, so the refusal names the band it measured:
  // not the container's own frame once an ancestor clips it.
  if (pull.pixels < REFRESH_PULL_MIN_PX) {
    throw new AppError(
      'COMMAND_FAILED',
      `scroll refresh found a scroll container too short to pull: ${pull.pixels}px of travel is below the ${REFRESH_PULL_MIN_PX}px that commits a refresh`,
      {
        reason: 'scroll_refresh_container_too_short',
        containerRect: visibleContainer,
        travelPixels: pull.pixels,
        hint: 'The refresh control needs a longer list. Scroll with a direction if the content should move.',
      },
    );
  }
  // The gesture planner is loaded here, not at the module's top: the daemon evaluates no gesture
  // planner on boot, and `scroll refresh` is the only scroll mode that needs one, so a static edge
  // would put the planner in every daemon's eager closure.
  const { buildGesturePlan } = await import('@agent-device/contracts/gesture-plan');
  const plan = buildGesturePlan(
    {
      intent: 'pan',
      origin: { x: pull.x1, y: pull.y1 },
      delta: { x: pull.x2 - pull.x1, y: pull.y2 - pull.y1 },
      durationMs: options.durationMs,
    },
    pull.viewport,
  );
  const gestureResult = await runtime.operations.performGesturePlan({
    plan,
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  });
  const durationMs = options.durationMs;
  return {
    report: {
      // The route the pull took: the profile of the plan that was dispatched. An Apple runner
      // echoes its own execution profile back; the Android helper names the lowered single-contact
      // form it synthesized, so the plan's own profile keeps the route readable on every platform.
      ...('executionProfile' in plan ? { executionProfile: plan.executionProfile } : {}),
      ...(gestureResult ?? {}),
      x1: pull.x1,
      y1: pull.y1,
      x2: pull.x2,
      y2: pull.y2,
      pixels: pull.pixels,
      ...(durationMs === undefined ? {} : { durationMs }),
    },
    pixels: pull.pixels,
    midpoint: { x: (pull.x1 + pull.x2) / 2, y: (pull.y1 + pull.y2) / 2 },
  };
}

/**
 * The gesture viewport the pull is planned in: the owner's own live read when it admitted one,
 * else the viewport the fresh capture itself names — so the container rect and the plan share
 * one coordinate space by construction.
 */
async function refreshGestureViewport(
  runtime: BoundScrollRefresh,
  nodes: readonly (RawSnapshotNode | SnapshotNode)[],
  context: DaemonCommandContext,
): Promise<Rect> {
  const read = runtime.operations.gestureViewport;
  if (read) {
    const input: GestureViewportInput = {
      ...(context.appBundleId === undefined
        ? {}
        : { options: { appBundleId: context.appBundleId } }),
      execution: runtimeExecutionFromContext(context),
    };
    return await read(input);
  }
  const viewport = inferGestureViewportRect(nodes);
  if (!viewport) {
    throw new AppError(
      'COMMAND_FAILED',
      'scroll refresh could not establish the gesture viewport from the captured screen',
      {
        reason: 'scroll_refresh_viewport_unknown',
        hint: 'Run snapshot -i for the current screen and retry.',
      },
    );
  }
  return viewport;
}

/**
 * The top-edge verdict a `scroll refresh` refuses or plans on, read off a freshly captured tree
 * inside the executor, before the pull dispatches. The session's stored snapshot is not used: a
 * previous gesture may have expired it (ADR 0014), and the stored tree can no longer honestly answer
 * whether the scroller still hides content above.
 */
async function readCapturedTopEdgeState(
  runtime: BoundScrollRefresh,
  context: DaemonCommandContext,
): Promise<
  Readonly<{ state: ScrollEdgeState; nodes: readonly (RawSnapshotNode | SnapshotNode)[] }>
> {
  context.signal?.throwIfAborted();
  const snapshot = await runtime.operations.captureSnapshot(scrollCaptureInput(context));
  const nodes = snapshot.nodes ?? [];
  const state = await readScrollPullContainer(nodes);
  // An unreadable capture is a capture failure, not "no scroller": refusing it as no_container would
  // tell the agent the app has no list when the read simply failed.
  if (state.emptySnapshot) {
    throw new AppError(
      'COMMAND_FAILED',
      'scroll refresh could not read the screen to find the scroll container',
      {
        reason: 'scroll_refresh_capture_unreadable',
        hint: 'Run snapshot -i for the current screen and retry.',
      },
    );
  }
  return { state, nodes };
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
  const interactionResult = await scrollOnce(runtime, target, options, context);
  const observed = await directionalMovementClaim(
    runtime,
    target.direction,
    context,
    movementPlan,
    interactionResult,
  );
  return scrollResult(target, options, 1, interactionResult, observed);
}

/** Any bound runtime that may carry the capture the movement claim reads. */
type CaptureCapableScrollRuntime = Readonly<{
  operations: Readonly<{
    captureSnapshot?: (input: CaptureSnapshotInput) => Promise<SnapshotResult>;
  }>;
}>;

/**
 * The movement this response may claim, or `undefined` when this command owed no observation of its own
 * effect at all. An absent `movement` field is a claim of its own, so every skip names a typed reason in
 * the daemon log; a runtime bound without a capture answers that way rather than `unobserved`, which
 * keeps its response exactly what it was before this observation existed.
 */
async function directionalMovementClaim(
  runtime: CaptureCapableScrollRuntime,
  direction: ScrollDirection,
  context: DaemonCommandContext,
  movementPlan: ScrollMovementPlan,
  interactionResult: ScrollDirectionResult,
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
      swipe: interactionResult,
    });
  }
  return await observeScrollMovement({
    direction,
    baseline: movementPlan.baseline,
    swipe: interactionResult,
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

/** Repeats the pass while the verified state still moves; the loop refuses an unreadable capture. */
async function executeEdgeScroll(
  runtime: BoundScrollEdge,
  edge: ScrollEdge,
  target: ScrollTarget,
  options: ResolvedScrollExecutionOptions,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const edgeResult = await runScrollEdgePasses({
    signal: context.signal,
    edge,
    captureState: async (scope) => await captureEdgeState(runtime, edge, scope, context),
    scroll: async () => await scrollOnce(runtime, target, options, context),
    settleAfterPass: async (scope) => {
      await pollForScrollRest(
        async () =>
          (await runtime.operations.captureSnapshot(scrollCaptureInput(context, { scope })))
            .nodes ?? [],
        edge,
        context.signal,
      );
    },
  });
  return scrollResult(target, options, edgeResult.passes, edgeResult.result ?? { report: {} });
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
    passLimit: context.maxPasses,
    signal: context.signal,
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
      ...untilResult.result?.report,
    },
    formatScrollUntilMessage(target.direction, selector, untilResult.passes),
  );
}

/**
 * One edge read, refused when the capture cannot show the screen. Refusal is decided on the capture
 * the analyzer last read — after an empty scoped tree, that is the unscoped retry — so neither a
 * failed read nor a sparse one reaches the edge verdict as "no hidden content" (#2468).
 */
async function captureEdgeState(
  runtime: BoundScrollEdge,
  edge: ScrollEdge,
  scope: string | undefined,
  context: DaemonCommandContext,
): Promise<ScrollEdgeObservation> {
  let lastCapture: SnapshotResult | undefined;
  const state = await captureScrollEdgeState({
    edge,
    scope,
    captureNodes: async (snapshotScope) => {
      context.signal?.throwIfAborted();
      lastCapture = await runtime.operations.captureSnapshot(
        scrollCaptureInput(context, { scope: snapshotScope }),
      );
      return lastCapture.nodes ?? [];
    },
  });
  const refused = lastCapture && scrollCaptureRefusal(lastCapture);
  return refused ? { refused } : state;
}

/** The single lexical owner of the bound call (R53); the edge binding satisfies this shape too. */
async function scrollOnce(
  runtime: BoundScrollDirection,
  target: ScrollTarget,
  options: ResolvedScrollExecutionOptions,
  context: DaemonCommandContext,
): Promise<ScrollDirectionResult> {
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
  signal?: AbortSignal,
  timeoutMs = SCROLL_REST_TIMEOUT_MS,
  pollMs = SCROLL_REST_POLL_MS,
): Promise<void> {
  let previous: string | undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const fingerprint = await scrollSurfaceFingerprint(await captureNodes(), edge);
    if (fingerprint === previous) return;
    previous = fingerprint;
    await sleep(pollMs, signal);
  }
}

/** The one response shape both executors report. Owner fields win, as the retired leaf had them. */
function scrollResult(
  target: ScrollTarget,
  options: ScrollCommandOptions,
  completedPasses: number,
  interactionResult: ScrollDirectionResult,
  movement?: ScrollMovementObservation,
): Record<string, unknown> {
  const honoredPixels = interactionResult.pixels;
  return withSuccessText(
    {
      direction: target.direction,
      ...(target.refresh === true ? { refresh: true } : {}),
      ...(target.edge ? { edge: target.edge, passes: completedPasses } : {}),
      ...(options.amount !== undefined ? { amount: options.amount } : {}),
      ...(options.pixels !== undefined ? { pixels: options.pixels } : {}),
      ...interactionResult.report,
      // The observation is this command's own claim about its effect, so it is the one field the
      // owner answers with rather than echoes from the platform leaf.
      ...(movement === undefined ? {} : { movement }),
    },
    formatScrollEdgeMessage({
      direction: target.direction,
      edge: target.edge,
      refresh: target.refresh === true ? true : undefined,
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
