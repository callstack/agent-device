import type { PreresolvedInteractionTarget } from '@agent-device/contracts/interaction';
import {
  isReadOnlyFindAction,
  checkFindArgs,
  parseFindSelectorExpression,
  type FindLocator,
} from '@agent-device/selectors';
import { runNodePipelineStages } from '../../core/selector-pipeline.ts';
import { SELECTOR_PIPELINE_POLICIES } from '../../core/selector-pipeline-policy.ts';
import { centerOfRect, type SnapshotState } from '@agent-device/kernel/snapshot';
import { expireRefFrame } from '../ref-frame.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { contextFromFlags } from '../context.ts';
import { readCommandMessage, successText } from '../../utils/success-text.ts';
import { errorResponse, noActiveSessionError } from './response.ts';
import { withSystemSurfaceDisclosure } from './system-surface-disclosure.ts';
import { recordSessionAction } from './handler-utils.ts';
import { stripInternalInteractionFlags } from '../interaction-outcome-policy.ts';
import { resolveFindMatch } from './find-match-resolution.ts';
import { executeFocusPoint } from '../focus-runtime.ts';
import { executeBoundTypeText } from '../type-text-runtime.ts';
import { dispatchFindReadOnlyViaRuntime } from '../selector-runtime.ts';
import { admitAndBindSnapshotCapture } from '../snapshot-runtime-binding.ts';
import type { FocusPointInput } from '@agent-device/contracts/focus-runtime';
import { resolveSelectorCaptureRuntimePlan } from '@agent-device/contracts/platform-runtime-operations';
import type { TypeTextRuntimeOperations } from '@agent-device/contracts/type-text-runtime';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { createFindTargetCapture, sparseFindSnapshotResponse } from './find-target-capture.ts';
import { isSparseSnapshotQualityVerdict } from '../../snapshot-quality/verdict.ts';

type FindContext = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  invoke: DaemonInvokeFn;
  session: SessionState;
  device: SessionState['device'];
  command: string;
  locator: FindLocator;
  query: string;
  publicFlags: Record<string, unknown>;
  /** The one action-selected bind's directly-executed operations (ADR 0019 §9). */
  boundFocusPoint?: (input: FocusPointInput) => Promise<void>;
  boundTypeText?: TypeTextRuntimeOperations['typeText'];
};

type ResolvedMatch = {
  node: SnapshotState['nodes'][number];
  resolvedNode: SnapshotState['nodes'][number];
  ref: string;
  nodes: SnapshotState['nodes'];
  actionFlags: Record<string, unknown>;
  /**
   * Set when find's row refuses this match as covered. Only the focus/type
   * seam surfaces it: click/fill re-enter the interaction leaf, which owns
   * that refusal's shape and raises it against the same node.
   */
  occludedNode?: SnapshotState['nodes'][number];
};

export async function handleFindCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  invoke: DaemonInvokeFn;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse | null> {
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
    req,
    sessionName,
    logPath,
    sessionStore,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (runtimeResponse) return runtimeResponse;
  // Read-only find actions (exists/wait/list/get_text/get_attrs) always return from
  // the selector runtime above, so only mutating actions (click/fill/focus/type)
  // reach this point — and every mutating find needs an active session.
  const session = sessionStore.get(sessionName);
  if (!session) return noActiveSessionError();
  const device = session.device;
  // R35 + ADR 0019 §9: ONE action-selected plan, ONE facts inspection, ONE bind. The plan
  // carries everything this action executes directly — the target capture always, plus
  // focusPoint for `find focus` and focusPoint+typeText for `find type` — so a leg can never
  // re-admit or re-bind mid-handler.
  const boundSelector = await admitAndBindSnapshotCapture({
    command: 'find',
    device,
    session,
    plan: resolveSelectorCaptureRuntimePlan({
      hasActiveApp: session.appBundleId !== undefined,
      intent: action === 'focus' ? 'find-focus' : action === 'type' ? 'find-type' : 'capture-only',
    }),
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (!boundSelector.ok) return boundSelector.response;
  const selectorExpression = parseFindSelectorExpression(locator, query);
  const readTargetTree = createFindTargetCapture({
    device,
    session,
    req,
    logPath,
    locator,
    query,
    sessionStore,
    sessionName,
    capture: boundSelector.capture,
  });

  const ctx: FindContext = {
    req,
    sessionName,
    logPath,
    sessionStore,
    invoke,
    session,
    device,
    command,
    locator,
    query,
    publicFlags: publicFindFlags(req.flags),
    boundFocusPoint: boundSelector.focusPoint,
    boundTypeText: boundSelector.typeText,
  };

  const snapshotResult = await readTargetTree();
  if (isSparseSnapshotQualityVerdict(snapshotResult.snapshotQuality)) {
    return sparseFindSnapshotResponse(snapshotResult.snapshotQuality);
  }
  const { nodes } = snapshotResult;
  const matchResult = resolveFindMatch({
    nodes,
    locator,
    query,
    selectorExpression,
    flags: req.flags,
    platform: device.platform,
  });
  // Matched and unmatched outcomes both consumed this capture: when it is an occluding system
  // surface, the response must disclose that app content is occluded.
  if (!matchResult.ok) return withSystemSurfaceDisclosure(matchResult.response, snapshotResult);
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
    nodes,
    actionFlags,
    ...(target.kind === 'occluded' ? { occludedNode: target.node } : {}),
  };

  const response = await dispatchFindAction(ctx, match, action, value);
  return response ? withSystemSurfaceDisclosure(response, snapshotResult) : response;
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
  return { ref: match.ref, node: match.resolvedNode, nodes: match.nodes };
}

async function handleFindClick(ctx: FindContext, match: ResolvedMatch): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore, session, invoke, command, locator, query, publicFlags } =
    ctx;
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
  recordSessionAction(
    sessionStore,
    session,
    req,
    command,
    { ref: match.ref, action: 'click', locator, query },
    { flags: publicFlags },
  );
  return { ok: true, data: matchData };
}

async function handleFindFill(
  ctx: FindContext,
  match: ResolvedMatch,
  value: string | undefined,
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore, session, invoke, command, publicFlags } = ctx;
  if (!value) {
    return errorResponse('INVALID_ARGS', 'find fill requires text');
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
  recordSessionAction(
    sessionStore,
    session,
    req,
    command,
    { ref: match.ref, action: 'fill' },
    { flags: publicFlags },
  );
  return response;
}

async function handleFindFocus(ctx: FindContext, match: ResolvedMatch): Promise<DaemonResponse> {
  const response = await dispatchFocusForFindMatch(ctx, match);
  if (!response.ok) return response;
  recordFindAction(ctx, match, 'focus');
  return response;
}

async function handleFindType(
  ctx: FindContext,
  match: ResolvedMatch,
  value: string | undefined,
): Promise<DaemonResponse> {
  const { req, logPath, session } = ctx;
  if (!value) {
    return errorResponse('INVALID_ARGS', 'find type requires text');
  }
  const focusResponse = await dispatchFocusForFindMatch(ctx, match);
  if (!focusResponse.ok) return focusResponse;
  // The focus above already crossed the seam; expiry is idempotent, but keep it
  // explicit at the type dispatch so it does not rely on the focus-first order.
  expireRefFrame(session);
  // R41/R35: the operation came from the handler's ONE action-selected bind; the shared
  // executor is the single lexical owner of the `typeText` call and of the leaf's parse.
  const typeText = ctx.boundTypeText;
  if (!typeText) {
    return errorResponse('COMMAND_FAILED', 'find type was admitted without a text-entry operation');
  }
  const response = await executeBoundTypeText(
    { operations: { typeText } },
    [value],
    contextFromFlags(logPath, req.flags, session.appBundleId, session.trace?.outPath),
  );
  recordFindAction(ctx, match, 'type');
  return { ok: true, data: response ?? { ref: match.ref } };
}

async function dispatchFocusForFindMatch(
  ctx: FindContext,
  match: ResolvedMatch,
): Promise<DaemonResponse> {
  const { req, logPath, session } = ctx;
  const coveredResponse = rejectCoveredFindMatch(match, 'be focused');
  if (coveredResponse) return coveredResponse;
  const coords = match.resolvedNode.rect ? centerOfRect(match.resolvedNode.rect) : null;
  if (!coords) {
    return errorResponse('COMMAND_FAILED', 'matched element has no bounds');
  }
  // ADR 0014 side-effect seam: mutating find focus/type dispatch the device
  // command directly (they do not re-enter the interaction leaf), so expire the
  // frame here before the device op. Pre-seam guards above preserve the frame.
  expireRefFrame(session);
  // R40/R35: the operation came from the handler's ONE action-selected bind; the shared
  // executor is the single lexical owner of the `focusPoint` call.
  const focusPoint = ctx.boundFocusPoint;
  if (!focusPoint) {
    return errorResponse('COMMAND_FAILED', 'find focus was admitted without a focus operation');
  }
  const response = await executeFocusPoint(
    { operations: { focusPoint } },
    coords,
    contextFromFlags(logPath, req.flags, session.appBundleId, session.trace?.outPath),
  );
  return { ok: true, data: response ?? { ref: match.ref } };
}

function rejectCoveredFindMatch(match: ResolvedMatch, interaction: string): DaemonResponse | null {
  const blockedNode = match.occludedNode;
  if (!blockedNode) return null;
  return errorResponse(
    'COMMAND_FAILED',
    `Matched element ${match.ref} is covered by another visible element and cannot ${interaction} safely`,
    {
      ref: `@${blockedNode.ref}`,
      interactionBlocked: blockedNode.interactionBlocked,
      hint: 'Use a different visible target, scroll it clear of the overlay, or inspect with snapshot/screenshot before retrying.',
    },
  );
}

function recordFindAction(ctx: FindContext, match: ResolvedMatch, action: string): void {
  const { req, sessionStore, session, command, publicFlags } = ctx;
  recordSessionAction(
    sessionStore,
    session,
    req,
    command,
    { ref: match.ref, action },
    { flags: publicFlags },
  );
}

// --- Helpers ---

function publicFindFlags(flags: DaemonRequest['flags']): Record<string, unknown> {
  return { ...(stripInternalInteractionFlags(flags) ?? {}) };
}
