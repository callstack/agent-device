import type { DaemonFailureResponse, DaemonResponse } from '@agent-device/kernel/contracts';
import type {
  PreresolvedInteractionTarget,
  SurfaceScopedNodes,
} from '@agent-device/contracts/interaction';
import { surfaceScopedNodes } from '@agent-device/capture-kit/snapshot-baseline';
import { assertSnapshotScreenOrigin } from '@agent-device/contracts/capture';
import {
  isReadOnlyFindAction,
  checkFindArgs,
  parseFindSelectorExpression,
  readSimpleSelectorTarget,
  type FindLocator,
} from '@agent-device/selectors';
import { runNodePipelineStages } from '@agent-device/selectors/selector-pipeline';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import {
  coveredInteractionDetails,
  INTERACTION_ERROR_REASONS,
} from '@agent-device/selectors/interaction-error';
import {
  resolveFocusTarget,
  resolveNodeTouchPoint,
} from '@agent-device/selectors/node-touch-point';
import {
  offscreenRefFailure,
  throwIfOffscreenTarget,
} from '@agent-device/selectors/interaction-offscreen';
import { describeNonHittableTarget } from '@agent-device/selectors/interaction-targeting';
import { isSnapshotNodeInteractionBlocked } from '@agent-device/capture-kit/snapshot-occlusion';
import { buildNestedTextFieldsError } from '../../selector-match-errors.ts';
import { assertTapTargetClearOfVisibleKeyboard } from '@agent-device/selectors/keyboard-occlusion';
import {
  interactionVerb,
  type InteractionAction,
} from '@agent-device/selectors/interaction-action';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  centerOfRect,
  type Point,
  type SnapshotAddressableNode,
  type SnapshotKeyboardBandFact,
} from '@agent-device/kernel/snapshot';
import { type SnapshotState } from '@agent-device/contracts/snapshot-model';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { DaemonInvokeFn, DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionState } from '../../../core/session-state.ts';
import type { AuthorizedMutation, SessionTargetContext } from '../../../core/session-store.ts';
import type { RecordActionEntry } from '../../../core/session-action-recorder.ts';
import { contextFromFlags } from '../../../core/context.ts';
import { readCommandMessage, successText } from '@agent-device/kernel/success-text';
import type { RequestCaptureProof } from '../../../core/capture-disclosure.ts';
import { withCaptureDisclosures } from '../../../core/capture-disclosure.ts';
import { stripInternalInteractionFlags } from '../../../core/deferred-interaction-outcome.ts';
import { resolveFindMatch } from './find-match-resolution.ts';
import { executeFocusPoint } from '../../focus-runtime.ts';
import { confirmIosOffscreenTargetVisible } from '../../offscreen-target-probe.ts';
import { executeBoundTypeText, parseTypeTextRequest } from '../../type-text-runtime.ts';
import { dispatchFindReadOnlyViaRuntime } from '../../selector-runtime.ts';
import { admitAndBindSnapshotCapture } from '../../../core/snapshot-runtime-binding.ts';
import type { BoundSelectorQuery } from '../../../core/selector-operation-binding.ts';
import { runtimeExecutionFromContext } from '../../../core/snapshot-runtime-capture-input.ts';
import type { FocusPointInput } from '@agent-device/contracts/focus-runtime';
import {
  findRuntimeIntent,
  resolveSelectorCaptureRuntimePlan,
} from '@agent-device/contracts/platform-runtime-operations';
import type { TypeTextRuntimeOperations } from '@agent-device/contracts/type-text-runtime';
import type { FindRouteInput } from '../../../core/interaction/internal/types.ts';
import { createFindTargetCapture, sparseFindSnapshotResponse } from './find-target-capture.ts';
import { isSparseSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { errorResponse, noActiveSessionError } from '@agent-device/kernel/contracts';

type FindContext = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  invoke: DaemonInvokeFn;
  /** This request's admitted session effects (ADR 0040): target context, frame expiry, and recording. */
  mutations: AuthorizedMutation;
  device: SessionState['device'];
  command: string;
  locator: FindLocator;
  query: string;
  publicFlags: CommandFlags;
  /** The one action-selected bind's directly-executed operations (ADR 0019 §9). */
  boundFocusPoint?: (input: FocusPointInput) => Promise<void>;
  boundTypeText?: TypeTextRuntimeOperations['typeText'];
  /** The same bind's conditional live selector read, present only when its owner advertised it. */
  boundQuerySelector?: BoundSelectorQuery;
};

type ResolvedMatch = {
  node: SnapshotState['nodes'][number];
  resolvedNode: SnapshotAddressableNode;
  ref: string;
  /** The target capture's baseline: its nodes with the surface and presentation they describe. */
  tree: SurfaceScopedNodes;
  /** The keyboard band that capture's producer measured, when it measured one (#2660). */
  keyboard?: SnapshotKeyboardBandFact;
  actionFlags: Record<string, unknown>;
  /**
   * Set when find's row refuses this match as covered. Only the focus/type
   * seam surfaces it: click/fill re-enter the interaction leaf, which owns
   * that refusal's shape and raises it against the same node.
   */
  occludedNode?: SnapshotAddressableNode;
};

export async function handleFindCommands(params: FindRouteInput): Promise<DaemonResponse | null> {
  const { req, sessionName, logPath, sessionStore, invoke } = params;
  const command = req.command;
  if (command !== 'find') return null;

  const args = req.positionals ?? [];
  const checked = checkFindArgs(args, req.flags);
  if (!checked.ok) return errorResponse(checked.code, checked.message);
  const { locator, query, action, value } = checked.parsed;
  // #1271 stage 2: `--record` only means something for an action the
  // repair-segment exclusion can drop. `find`'s observe-vs-mutate split is a
  // POSITIONAL, so unlike snapshot/get/is it cannot be settled by the CLI
  // grammar's per-command `allowedFlags` — it is validated here instead, before
  // any device work, so every surface (CLI/Node/MCP) inherits the same refusal
  // rather than silently ignoring the flag on a mutating find.
  if (req.flags?.record && !isReadOnlyFindAction(action)) {
    return errorResponse(
      'INVALID_ARGS',
      `find ${action} is a mutating action and is always recorded; --record only applies to a read-only find (exists, wait, list, get text, get attrs).`,
    );
  }
  const runtimeResponse = await dispatchFindReadOnlyViaRuntime({
    createCommandSurface: params.createCommandSurface,
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (runtimeResponse) return runtimeResponse;
  // Read-only find actions (exists/wait/list/get_text/get_attrs) always return from
  // the selector runtime above, so only mutating actions (click/fill/focus/type)
  // reach this point — and every mutating find needs an active session. The dispatcher admitted
  // exactly one lifetime for this request and hands its effects here, so the action branches below
  // never resolve the address again and cannot land on a session that replaced the admitted one.
  if (!params.findSession) return noActiveSessionError();
  const { captureRef: sessionRef, mutations } = params.findSession;
  const admittedTarget = mutations.requireTargetContext();
  const device = admittedTarget.device;
  // R35 + ADR 0019 §9: ONE action-selected plan, ONE facts inspection, ONE bind. The plan
  // carries everything this action executes directly — the target capture always, plus
  // focusPoint for `find focus` and focusPoint+typeText for `find type` — so a leg can never
  // re-admit or re-bind mid-handler.
  const boundSelector = await admitAndBindSnapshotCapture({
    command: 'find',
    device,
    session: { name: admittedTarget.name },
    plan: resolveSelectorCaptureRuntimePlan({
      hasActiveApp: admittedTarget.appBundleId !== undefined,
      intent: findRuntimeIntent(action),
    }),
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (!boundSelector.ok) return boundSelector.response;
  const selectorExpression = parseFindSelectorExpression(locator, query);
  // One proof for the whole request: whichever capture of find's (first pass or a sparse re-capture)
  // activated the session app owns the disclosure, including when the re-capture's tree is the one
  // that survives and gets answered from (#2682).
  const captureProof: RequestCaptureProof = {};
  const readTargetTree = createFindTargetCapture({
    ref: sessionRef,
    device,
    req,
    logPath,
    locator,
    query,
    sessionStore,
    sessionName,
    capture: boundSelector.capture,
    captureProof,
  });

  const ctx: FindContext = {
    mutations,
    req,
    sessionName,
    logPath,
    invoke,
    device,
    command,
    locator,
    query,
    publicFlags: publicFindFlags(req.flags),
    boundFocusPoint: boundSelector.focusPoint,
    boundTypeText: boundSelector.typeText,
    boundQuerySelector: boundSelector.querySelector,
  };

  const snapshotResult = await readTargetTree();
  if (isSparseSnapshotQualityVerdict(snapshotResult.snapshotQuality)) {
    // A sparse tree still consumed this request's capture, so the repair it paid for is owed here too
    // — this return used to be the one find exit with no disclosure at all (#2682).
    return withCaptureDisclosures({
      response: sparseFindSnapshotResponse(snapshotResult.snapshotQuality),
      consumedTree: snapshotResult,
      captureProof,
    });
  }
  const { nodes } = snapshotResult;
  const matchResult = resolveFindMatch({
    nodes,
    locator,
    query,
    action,
    selectorExpression,
    flags: req.flags,
    platform: device.platform,
  });
  // Matched and unmatched outcomes both consumed this capture: when it is an occluding system
  // surface, the response must disclose that app content is occluded.
  // Find resolves its target from a capture it took itself, so the same tree is both what the
  // response describes and what this request paid for.
  if (!matchResult.ok) {
    return withCaptureDisclosures({
      response: matchResult.response,
      consumedTree: snapshotResult,
      captureProof,
    });
  }
  const node = matchResult.node;
  // Every node stage find's row declares, in one call.
  const target = await runNodePipelineStages(SELECTOR_PIPELINE_POLICIES.findAct, nodes, node);
  const resolvedNode = target.node;
  const ref = `@${resolvedNode.ref}`;
  const actionFlags = { ...(req.flags ?? {}), noRecord: true };
  const match: ResolvedMatch = {
    node,
    resolvedNode,
    ref,
    tree: surfaceScopedNodes(snapshotResult),
    ...(snapshotResult.keyboard ? { keyboard: snapshotResult.keyboard } : {}),
    actionFlags,
    ...(target.kind === 'occluded' ? { occludedNode: target.node } : {}),
  };

  const response = await dispatchFindAction(ctx, match, action, value);
  return response
    ? withCaptureDisclosures({
        response,
        consumedTree: snapshotResult,
        captureProof,
      })
    : response;
}

/**
 * Run the selected mutating find action. A mutating find (click/fill/focus/type)
 * returns `data.ref` solely as diagnostic pre-action identity (ADR 0014) — it
 * must omit `refsGeneration` so MCP cannot pin and reuse it after the action.
 */
async function dispatchFindAction(
  ctx: FindContext,
  match: ResolvedMatch,
  action: string,
  value: string | undefined,
): Promise<DaemonResponse | null> {
  const actionHandlers: Record<string, () => Promise<DaemonResponse | null>> = {
    click: () => handleFindClick(ctx, match),
    fill: () => handleFindFill(ctx, match, value),
    focus: () => handleFindFocus(ctx, match),
    type: () => handleFindType(ctx, match, value),
  };

  const handler = actionHandlers[action];
  if (!handler) return null;
  return await handler();
}

// --- Per-action handlers ---

/**
 * #1654: hand the interaction leaf the node this find already resolved, so the
 * leaf stops resolving `match.ref` a second time.
 *
 * `match.resolvedNode` is the end of find's own pipeline — locator match under
 * the `findAct` policy, then `resolveInteractiveMatchNode` promotion — and
 * `match.ref` is minted off it. Re-entering by bare `@ref` made the leaf repeat
 * that lookup. The handoff keeps ref, node, and source tree as one value so
 * admission policy and lookup cannot drift independently. The leaf's guards
 * (occlusion, promotion, off-screen) still run on this node.
 */
function preresolvedTarget(match: ResolvedMatch): PreresolvedInteractionTarget {
  return {
    ref: match.ref,
    node: match.resolvedNode,
    tree: match.tree,
    // #2660: the leaf's keyboard guard measures the band this capture measured, not one it re-derives.
    ...(match.keyboard ? { keyboard: match.keyboard } : {}),
  };
}

async function handleFindClick(ctx: FindContext, match: ResolvedMatch): Promise<DaemonResponse> {
  const { req, sessionName, invoke, locator, query } = ctx;
  const response = await invoke({
    token: req.token,
    session: sessionName,
    command: 'click',
    positionals: [match.ref],
    flags: match.actionFlags,
    internal: { findResolvedTarget: preresolvedTarget(match) },
  });
  if (!response.ok) return response;
  const matchCoords = match.resolvedNode.rect
    ? centerOfRect(match.resolvedNode.rect)
    : match.node.rect
      ? centerOfRect(match.node.rect)
      : null;
  const matchData: Record<string, unknown> = { ref: match.ref, locator, query };
  if (matchCoords) {
    matchData.x = matchCoords.x;
    matchData.y = matchCoords.y;
  }
  const clickMessage =
    readCommandMessage(response.data as Record<string, unknown>) ??
    `Tapped ${match.ref}${matchCoords ? ` (${matchCoords.x}, ${matchCoords.y})` : ''}`;
  Object.assign(matchData, successText(clickMessage));
  recordFindAction(ctx, match, 'click', { ref: match.ref, action: 'click', locator, query });
  return { ok: true, data: matchData };
}

async function handleFindFill(
  ctx: FindContext,
  match: ResolvedMatch,
  value: string | undefined,
): Promise<DaemonResponse> {
  const { req, sessionName, invoke } = ctx;
  // `''` is the clear request (#2063); only a MISSING value is an error.
  if (value === undefined) {
    return errorResponse('INVALID_ARGS', 'find fill requires text (use "" to clear the field)');
  }
  const response = await invoke({
    token: req.token,
    session: sessionName,
    command: 'fill',
    positionals: [match.ref, value],
    flags: match.actionFlags,
    internal: { findResolvedTarget: preresolvedTarget(match) },
  });
  if (!response.ok) return response;
  recordFindAction(ctx, match, 'fill', { ref: match.ref, action: 'fill' });
  return response;
}

async function handleFindFocus(ctx: FindContext, match: ResolvedMatch): Promise<DaemonResponse> {
  const focused = await dispatchFocusForFindMatch(ctx, match, 'focus');
  if (!focused.ok) return focused;
  recordFindAction(ctx, match, 'focus');
  return { ok: true, data: { ...focused.data, ...focused.targetAnnotation } };
}

async function handleFindType(
  ctx: FindContext,
  match: ResolvedMatch,
  value: string | undefined,
): Promise<DaemonResponse> {
  if (!value) {
    return errorResponse('INVALID_ARGS', 'find type requires text');
  }
  const context = () => contextFromTargetContext(ctx);
  // The value is always text here, so a leading `@e12` is typed, not refused as a target ref.
  const request = parseTypeTextRequest([value], context(), { rejectRefTarget: false });
  const focused = await dispatchFocusForFindMatch(ctx, match, 'type');
  if (!focused.ok) return focused;
  // The focus above already crossed the seam; expiry is idempotent, but keep it
  // explicit at the type dispatch so it does not rely on the focus-first order.
  ctx.mutations.expireRefFrame();
  // R41/R35: the operation came from the handler's ONE action-selected bind; the shared
  // executor is the single lexical owner of the `typeText` call and of the leaf's parse.
  const typeText = ctx.boundTypeText;
  if (!typeText) {
    return errorResponse('COMMAND_FAILED', 'find type was admitted without a text-entry operation');
  }
  const response = await executeBoundTypeText({ operations: { typeText } }, request, context());
  recordFindAction(ctx, match, 'type');
  return { ok: true, data: { ...response, ...focused.targetAnnotation } };
}

/**
 * The focus leg's dispatch result, with the non-hittable annotation of the node it focused kept apart
 * so `type` can answer with it beside its own text payload.
 */
type FindFocusDispatch =
  | DaemonFailureResponse
  | {
      ok: true;
      data: Record<string, unknown>;
      targetAnnotation: ReturnType<typeof describeNonHittableTarget>;
    };

async function dispatchFocusForFindMatch(
  ctx: FindContext,
  match: ResolvedMatch,
  action: 'focus' | 'type',
): Promise<FindFocusDispatch> {
  const coveredResponse = rejectCoveredFindMatch(match, 'focus');
  if (coveredResponse) return coveredResponse;
  const focusTarget = resolveFocusTarget({
    located: match.node,
    resolved: match.resolvedNode,
    nodes: match.tree.nodes,
    platform: ctx.device.platform,
  });
  if (focusTarget.kind === 'several-fields') {
    return buildNestedTextFieldsError(match.ref, focusTarget.fields);
  }
  if (focusTarget.kind === 'disabled-field') {
    return errorResponse(
      'COMMAND_FAILED',
      `Matched element @${focusTarget.node.ref} is a disabled text field and cannot be focused`,
      {
        reason: INTERACTION_ERROR_REASONS.targetDisabled.reason,
        ref: `@${focusTarget.node.ref}`,
        hint: 'Enable the field first, or target a different one.',
      },
    );
  }
  const located = focusTarget.node;
  if (isSnapshotNodeInteractionBlocked(located)) return coveredFindResponse(located, 'focus');
  const targetRef = `@${located.ref}`;
  let target: SnapshotAddressableNode;
  let coords: Point;
  // The same off-screen, touch-point and keyboard decisions the acting paths run
  // (#1542/#2589/#2622/#3734): this seam dispatches the point itself instead of re-entering the
  // interaction leaf, so they have to run here. find's ranking already preferred an on-screen match.
  try {
    await assertSnapshotScreenOrigin(match.tree.nodes, `Ref ${targetRef}`);
    const refFailure = offscreenRefFailure(targetRef, 'focus');
    target = await throwIfOffscreenTarget(
      located,
      match.tree.nodes,
      {
        ...refFailure,
        hint: (direction) =>
          `${direction ? `Scroll ${direction} toward it` : 'Scroll toward it'} or open its container, then re-run find to ${action}.`,
      },
      offscreenRescue(ctx),
    );
    coords = resolveNodeTouchPoint(target, match.tree.nodes, {
      invalidMessage: `Ref ${targetRef} has no usable bounds`,
      blockedTargetLabel: `Ref ${targetRef}`,
      blockedTargetDetails: { ref: targetRef },
    });
    assertTapTargetClearOfVisibleKeyboard({
      nodes: match.tree.nodes,
      node: target,
      action: 'focus',
      label: `Ref ${targetRef}`,
      ...(match.keyboard ? { keyboard: match.keyboard } : {}),
      tapPoint: coords,
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
  // ADR 0014 side-effect seam: mutating find focus/type dispatch the device
  // command directly (they do not re-enter the interaction leaf), so expire the
  // frame here before the device op. Pre-seam guards above preserve the frame.
  ctx.mutations.expireRefFrame();
  // R40/R35: the operation came from the handler's ONE action-selected bind; the shared
  // executor is the single lexical owner of the `focusPoint` call.
  const focusPoint = ctx.boundFocusPoint;
  if (!focusPoint) {
    return errorResponse('COMMAND_FAILED', 'find focus was admitted without a focus operation');
  }
  const response = await executeFocusPoint(
    { operations: { focusPoint } },
    coords,
    contextFromTargetContext(ctx),
  );
  return { ok: true, data: response, targetAnnotation: describeNonHittableTarget(target, 'focus') };
}

function directIdentityFindSelector(
  ctx: FindContext,
): Readonly<{ key: 'id' | 'label'; value: string }> | null {
  if (ctx.locator === 'id' || ctx.locator === 'label') {
    const value = ctx.query.trim();
    return value ? { key: ctx.locator, value } : null;
  }
  if (ctx.locator !== 'any') return null;
  const target = readSimpleSelectorTarget(ctx.query);
  if (!target || (target.key !== 'id' && target.key !== 'label')) return null;
  const value = target.value.trim();
  return value ? { key: target.key, value } : null;
}

/**
 * The #1542 rescue read over the bind's conditional live selector query, or `undefined` when the
 * owner did not advertise one or the find locator cannot be verified as an exact `id`/`label`
 * match on the focused node, so the off-screen rule fails closed on the capture's verdict.
 */
function offscreenRescue(ctx: FindContext): Parameters<typeof throwIfOffscreenTarget>[3] {
  const querySelector = ctx.boundQuerySelector;
  const exactSelector = directIdentityFindSelector(ctx);
  if (!querySelector || !exactSelector) return undefined;
  const target = ctx.mutations.requireTargetContext();
  return async (node, rootViewport) => {
    const nodeValue = exactSelector.key === 'id' ? node.identifier?.trim() : node.label?.trim();
    if (nodeValue !== exactSelector.value) return null;
    return await confirmIosOffscreenTargetVisible({
      session: target,
      node,
      rootViewport,
      querySelector,
      execution: runtimeExecutionFromContext(contextFromTargetContext(ctx, target)),
      exactSelector,
    });
  };
}

function rejectCoveredFindMatch(
  match: ResolvedMatch,
  action: InteractionAction,
): DaemonFailureResponse | null {
  return match.occludedNode ? coveredFindResponse(match.occludedNode, action) : null;
}

function coveredFindResponse(
  blockedNode: SnapshotAddressableNode,
  action: InteractionAction,
): DaemonFailureResponse {
  return errorResponse(
    'COMMAND_FAILED',
    `Matched element @${blockedNode.ref} is covered by another visible element and cannot ${interactionVerb(action)} safely`,
    coveredInteractionDetails(blockedNode),
  );
}

/**
 * The runtime context of the admitted session: the same three facts the direct store read used to
 * hand the executors, taken from the lifetime-bound projection instead.
 */
function contextFromTargetContext(
  ctx: FindContext,
  target: SessionTargetContext = ctx.mutations.requireTargetContext(),
) {
  return contextFromFlags(ctx.logPath, ctx.req.flags, target.appBundleId, target.traceLogPath);
}

/**
 * Records find's action against the admitted lifetime. `click` and `fill` pass their own result
 * payload; every other action records the resolved ref and its own name.
 */
function recordFindAction(
  ctx: FindContext,
  match: ResolvedMatch,
  action: string,
  result?: RecordActionEntry['result'],
): void {
  const { req, command, publicFlags } = ctx;
  ctx.mutations.recordAction({
    command,
    positionals: req.positionals ?? [],
    flags: publicFlags,
    result: result ?? { ref: match.ref, action },
  });
}

// --- Helpers ---

function publicFindFlags(flags: CommandFlags | undefined): CommandFlags {
  return { ...(stripInternalInteractionFlags(flags) ?? {}) };
}
