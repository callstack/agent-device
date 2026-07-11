import { dispatchCommand, resolveTargetDevice } from '../../core/dispatch.ts';
import { sleep } from '../../utils/timeouts.ts';
import {
  findBestMatchesByLocator,
  parseFindArgs,
  parseFindSelectorExpression,
  type FindLocator,
} from '../../selectors/find.ts';
import { centerOfRect, type SnapshotState } from '../../kernel/snapshot.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { contextFromFlags } from '../context.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import { extractNodeText } from '../../snapshot/snapshot-processing.ts';
import {
  resolveActionableTouchNode,
  resolveActionableTouchResolution,
} from '../../core/interaction-targeting.ts';
import { isSnapshotNodeInteractionBlocked } from '../../snapshot/snapshot-occlusion.ts';
import { readTextForNode } from './interaction-read.ts';
import { readCommandMessage, successText } from '../../utils/success-text.ts';
import { errorResponse, noActiveSessionError } from './response.ts';
import { recordSessionAction } from './handler-utils.ts';
import { stripInternalInteractionFlags } from '../interaction-outcome-policy.ts';
import { dispatchFindReadOnlyViaRuntime } from '../selector-runtime.ts';
import { markSessionSnapshotRefsIssued } from '../session-snapshot.ts';
import { createSelectorCaptureRuntime } from '../selector-capture-runtime.ts';
import {
  isSparseSnapshotQualityVerdict,
  type SnapshotQualityVerdict,
} from '../../snapshot/snapshot-quality.ts';
import { resolveSelectorChain } from '../../selectors/index.ts';
import type { SelectorChain } from '../../selectors/parse.ts';

type FindContext = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  invoke: DaemonInvokeFn;
  session: ReturnType<SessionStore['get']>;
  device: NonNullable<ReturnType<SessionStore['get']>>['device'];
  command: string;
  locator: FindLocator;
  query: string;
  publicFlags: Record<string, unknown>;
};

type ResolvedMatch = {
  node: SnapshotState['nodes'][number];
  resolvedNode: SnapshotState['nodes'][number];
  ref: string;
  nodes: SnapshotState['nodes'];
  actionFlags: Record<string, unknown>;
};

type FindMatchResult =
  | { ok: true; node: SnapshotState['nodes'][number] }
  | { ok: false; response: DaemonResponse };

export async function handleFindCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, logPath, sessionStore, invoke } = params;
  const command = req.command;
  if (command !== 'find') return null;

  const args = req.positionals ?? [];
  if (args.length === 0) {
    return errorResponse('INVALID_ARGS', 'find requires a locator or text');
  }
  const { locator, query, action, value, timeoutMs } = parseFindArgs(args);
  if (!query) {
    return errorResponse('INVALID_ARGS', 'find requires a value');
  }
  if (req.flags?.findFirst && req.flags?.findLast) {
    return errorResponse('INVALID_ARGS', 'find accepts only one of --first or --last');
  }
  const runtimeResponse = await dispatchFindReadOnlyViaRuntime({
    req,
    sessionName,
    logPath,
    sessionStore,
  });
  if (runtimeResponse) return runtimeResponse;
  const session = sessionStore.get(sessionName);
  const isReadOnly = isReadOnlyFindAction(action);
  if (!session && !isReadOnly) {
    return noActiveSessionError();
  }
  const device = session?.device ?? (await resolveTargetDevice(req.flags ?? {}));
  if (!session) {
    await ensureDeviceReady(device);
  }
  const requiresRect = findActionRequiresRect(action);
  // Interaction targets need the full interactive tree so duplicate labels can be
  // resolved against viewport visibility before an off-screen subtree wins.
  const selectorChain = parseFindSelectorExpression(locator, query);
  const scope =
    device.platform !== 'web' && !selectorChain && shouldScopeFind(locator) && !requiresRect
      ? query
      : undefined;
  const fetchNodes = createFindNodeFetcher({
    device,
    session,
    req,
    logPath,
    locator,
    query,
    scope,
    interactiveOnly: requiresRect,
    sessionStore,
    sessionName,
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
  };

  if (action === 'wait') {
    return handleFindWait(ctx, fetchNodes, locator, query, timeoutMs);
  }

  const snapshotResult = await fetchNodes();
  if (isSparseSnapshotQualityVerdict(snapshotResult.snapshotQuality)) {
    return sparseFindSnapshotResponse(snapshotResult.snapshotQuality);
  }
  const { nodes } = snapshotResult;
  const matchResult = resolveFindMatch({
    nodes,
    locator,
    query,
    selectorChain,
    requiresRect,
    flags: req.flags,
    platform: device.platform,
  });
  if (!matchResult.ok) return matchResult.response;
  const node = matchResult.node;
  const resolvedNode = requiresRect ? resolveInteractiveMatchNode(nodes, node) : node;
  const ref = `@${resolvedNode.ref}`;
  const actionFlags = { ...(req.flags ?? {}), noRecord: true };
  const match: ResolvedMatch = { node, resolvedNode, ref, nodes, actionFlags };
  if (session) {
    // #1076 clear choke point: every action below returns `match.ref`, minted
    // from the snapshot the capture runtime just stored, so the client leaves
    // with a ref that matches the stored tree. Clearing here also keeps the
    // internal `click/fill @ref` sub-invocations from attaching a spurious
    // stale-refs warning to the find response.
    markSessionSnapshotRefsIssued(session);
    sessionStore.set(sessionName, session);
  }

  const actionHandlers: Record<string, () => Promise<DaemonResponse | null>> = {
    exists: () => handleFindExists(ctx),
    get_text: () => handleFindGetText(ctx, match),
    get_attrs: () => handleFindGetAttrs(ctx, match),
    click: () => handleFindClick(ctx, match),
    fill: () => handleFindFill(ctx, match, value),
    focus: () => handleFindFocus(ctx, match),
    type: () => handleFindType(ctx, match, value),
  };

  const handler = actionHandlers[action];
  if (!handler) return null;
  // Re-read the session AFTER the handler: internal click/fill sub-invocations
  // may have replaced the stored tree again (Android freshness refresh), and
  // the reported generation must describe the tree the response's ref resolves
  // against at response time.
  return attachIssuedRefsGeneration(await handler(), () => sessionStore.get(sessionName));
}

/**
 * #1076 versioned refs: a find response that returns a ref is a ref-issuing
 * response, so it carries the stored tree's generation ONCE as the additive
 * `refsGeneration` field (the ref itself stays plain `@e12` — token economy).
 */
function attachIssuedRefsGeneration(
  response: DaemonResponse | null,
  getSession: () => SessionState | undefined,
): DaemonResponse | null {
  if (!response?.ok || !response.data || typeof response.data.ref !== 'string') return response;
  const refsGeneration = getSession()?.snapshotGeneration;
  if (refsGeneration === undefined) return response;
  return { ...response, data: { ...response.data, refsGeneration } };
}

// --- Per-action handlers ---

function isReadOnlyFindAction(action: string): boolean {
  return (
    action === 'exists' || action === 'wait' || action === 'get_text' || action === 'get_attrs'
  );
}

function findActionRequiresRect(action: string): boolean {
  return action === 'click' || action === 'focus' || action === 'fill' || action === 'type';
}

type FindSnapshotResult = {
  nodes: SnapshotState['nodes'];
  truncated?: boolean;
  backend?: SnapshotState['backend'];
  snapshotQuality?: SnapshotQualityVerdict;
};

type FindNodeFetcher = () => Promise<FindSnapshotResult>;

function createFindNodeFetcher(params: {
  device: SessionState['device'];
  session: SessionState | undefined;
  req: DaemonRequest;
  logPath: string;
  locator: FindLocator;
  query: string;
  scope: string | undefined;
  interactiveOnly: boolean;
  sessionStore: SessionStore;
  sessionName: string;
}): FindNodeFetcher {
  const { device, session, req, logPath, locator, query, scope, interactiveOnly } = params;
  const { sessionStore, sessionName } = params;
  const captureRuntime = createSelectorCaptureRuntime({
    device,
    session,
    sessionStore,
    sessionName,
    req,
    logPath,
  });
  return async () => {
    const { snapshot } = await captureRuntime.capture({
      flags: {
        ...req.flags,
        snapshotInteractiveOnly: interactiveOnly,
      },
      snapshotScope: scope,
      recovery: interactiveOnly
        ? {
            legacyIosSparse: {
              query,
              scope,
              shouldScope: shouldScopeFind(locator),
            },
            sparseVerdictQueryScope: {
              query,
              shouldScope: shouldScopeFind(locator),
            },
          }
        : undefined,
    });
    const snapshotResult = {
      nodes: snapshot.nodes,
      truncated: snapshot.truncated,
      backend: snapshot.backend,
      snapshotQuality: snapshot.snapshotQuality,
    };
    return snapshotResult;
  };
}

function sparseFindSnapshotResponse(verdict: SnapshotQualityVerdict): DaemonResponse {
  return errorResponse('COMMAND_FAILED', 'find could not read the current accessibility tree', {
    reason: verdict.reason,
    hint: 'The snapshot quality verdict is sparse. Use screenshot as visual truth, navigate with coordinates if needed, then retry find after reaching a readable screen.',
  });
}

function resolveFindMatch(params: {
  nodes: SnapshotState['nodes'];
  locator: FindLocator;
  query: string;
  selectorChain: SelectorChain | null;
  requiresRect: boolean;
  flags: DaemonRequest['flags'];
  platform: SessionState['device']['platform'];
}): FindMatchResult {
  const { nodes, locator, query, selectorChain, requiresRect, flags, platform } = params;
  const searchableNodes = requiresRect
    ? nodes.filter((node) => !isRootInteractionContainer(node, nodes[0]))
    : nodes;
  if (selectorChain) {
    const resolved = resolveSelectorChain(searchableNodes, selectorChain, {
      platform,
      requireRect: requiresRect,
      requireUnique: false,
    });
    if (!resolved) {
      return {
        ok: false,
        response: errorResponse('COMMAND_FAILED', 'find did not match any element'),
      };
    }
    return { ok: true, node: resolved.node };
  }
  const bestMatches = findBestMatchesByLocator(searchableNodes, locator, query, {
    requireRect: requiresRect,
  });
  if (requiresRect) {
    bestMatches.matches = preferOnscreenMatches(bestMatches.matches, nodes);
  }

  if (requiresRect && bestMatches.matches.length > 1) {
    const narrowed = narrowMultipleMatches(bestMatches.matches, flags);
    if (!narrowed) {
      return { ok: false, response: buildAmbiguousMatchError(bestMatches.matches, locator, query) };
    }
    bestMatches.matches = narrowed;
  }

  const node = bestMatches.matches[0] ?? null;
  if (!node) {
    return {
      ok: false,
      response: errorResponse('COMMAND_FAILED', 'find did not match any element'),
    };
  }
  return { ok: true, node };
}

function narrowMultipleMatches(
  matches: SnapshotState['nodes'],
  flags: DaemonRequest['flags'],
): SnapshotState['nodes'] | null {
  if (flags?.findFirst) return [matches[0]!];
  if (flags?.findLast) return [matches[matches.length - 1]!];
  return null;
}

function preferOnscreenMatches(
  matches: SnapshotState['nodes'],
  nodes: SnapshotState['nodes'],
): SnapshotState['nodes'] {
  const viewport = nodes[0]?.rect;
  if (!viewport) return matches;
  const onscreen = matches.filter((node) => {
    if (!node.rect) return false;
    const center = centerOfRect(node.rect);
    return (
      center.x >= viewport.x &&
      center.x <= viewport.x + viewport.width &&
      center.y >= viewport.y &&
      center.y <= viewport.y + viewport.height
    );
  });
  return rankInteractiveMatches(onscreen.length > 0 ? onscreen : matches, nodes);
}

function rankInteractiveMatches(
  matches: SnapshotState['nodes'],
  nodes: SnapshotState['nodes'],
): SnapshotState['nodes'] {
  if (matches.length < 2) return matches;
  return matches
    .map((node, index) => ({ node, index, score: interactiveMatchScore(node, nodes) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return rectArea(left.node) - rectArea(right.node) || left.index - right.index;
    })
    .map((entry) => entry.node);
}

function interactiveMatchScore(
  node: SnapshotState['nodes'][number],
  nodes: SnapshotState['nodes'],
): number {
  const resolution = resolveActionableTouchResolution(nodes, node);
  if (resolution.reason === 'covered') return 0;
  const resolved = resolvedTouchScore(resolution, nodes[0]);
  if (resolved > 0) return resolved;
  if (node.hittable && node.rect && !isRootInteractionContainer(node, nodes[0])) return 3;
  return node.rect ? 1 : 0;
}

function resolvedTouchScore(
  resolution: ReturnType<typeof resolveActionableTouchResolution>,
  root: SnapshotState['nodes'][number] | undefined,
): number {
  if (!resolution.node.rect) return 0;
  if (resolution.reason === 'semantic-target' || resolution.reason === 'same-rect-descendant') {
    return 4;
  }
  if (
    resolution.reason === 'hittable-ancestor' &&
    !isRootInteractionContainer(resolution.node, root)
  ) {
    return 2;
  }
  return 0;
}

function rectArea(node: SnapshotState['nodes'][number]): number {
  return node.rect ? node.rect.width * node.rect.height : Number.POSITIVE_INFINITY;
}

function resolveInteractiveMatchNode(
  nodes: SnapshotState['nodes'],
  node: SnapshotState['nodes'][number],
): SnapshotState['nodes'][number] {
  const resolved = resolveActionableTouchNode(nodes, node);
  if (isRootInteractionContainer(resolved, nodes[0]) && node.rect) return node;
  return resolved;
}

function isRootInteractionContainer(
  node: SnapshotState['nodes'][number],
  root: SnapshotState['nodes'][number] | undefined,
): boolean {
  if (!root?.rect || !node.rect) return false;
  const type = node.type?.toLowerCase() ?? '';
  if (!type.includes('application') && !type.includes('window')) return false;
  return rectsMatch(node.rect, root.rect);
}

function rectsMatch(
  left: NonNullable<SnapshotState['nodes'][number]['rect']>,
  right: NonNullable<SnapshotState['nodes'][number]['rect']>,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

async function handleFindWait(
  ctx: FindContext,
  fetchNodes: FindNodeFetcher,
  locator: FindLocator,
  query: string,
  timeoutMs: number | undefined,
): Promise<DaemonResponse> {
  const { req, sessionStore, session, command, publicFlags } = ctx;
  const timeout = timeoutMs ?? 10000;
  const start = Date.now();
  let sparseVerdict: SnapshotQualityVerdict | undefined;
  while (Date.now() - start < timeout) {
    const { nodes, snapshotQuality } = await fetchNodes();
    if (isSparseSnapshotQualityVerdict(snapshotQuality)) {
      sparseVerdict = snapshotQuality;
      await sleep(300);
      continue;
    }
    const match = findBestMatchesByLocator(nodes, locator, query, { requireRect: false })
      .matches[0];
    if (match) {
      recordSessionAction(
        sessionStore,
        session,
        req,
        command,
        { found: true, waitedMs: Date.now() - start },
        { flags: publicFlags },
      );
      return { ok: true, data: { found: true, waitedMs: Date.now() - start } };
    }
    await sleep(300);
  }
  if (sparseVerdict) return sparseFindSnapshotResponse(sparseVerdict);
  return errorResponse('COMMAND_FAILED', 'find wait timed out');
}

async function handleFindExists(ctx: FindContext): Promise<DaemonResponse> {
  const { req, sessionStore, session, command, publicFlags } = ctx;
  recordSessionAction(sessionStore, session, req, command, { found: true }, { flags: publicFlags });
  return { ok: true, data: { found: true } };
}

async function handleFindGetText(ctx: FindContext, match: ResolvedMatch): Promise<DaemonResponse> {
  const { req, sessionStore, session, command, device, logPath, publicFlags } = ctx;
  const text = await readTextForNode({
    device,
    node: match.node,
    flags: req.flags,
    appBundleId: session?.appBundleId,
    traceOutPath: session?.trace?.outPath,
    surface: session?.surface,
    contextFromFlags: (flags, appBundleId, traceLogPath) =>
      contextFromFlags(logPath, flags, appBundleId, traceLogPath),
  });
  recordSessionAction(
    sessionStore,
    session,
    req,
    command,
    { ref: match.ref, action: 'get text', text },
    { flags: publicFlags },
  );
  return { ok: true, data: { ref: match.ref, text, node: match.node } };
}

async function handleFindGetAttrs(ctx: FindContext, match: ResolvedMatch): Promise<DaemonResponse> {
  const { req, sessionStore, session, command, publicFlags } = ctx;
  recordSessionAction(
    sessionStore,
    session,
    req,
    command,
    { ref: match.ref, action: 'get attrs' },
    { flags: publicFlags },
  );
  return { ok: true, data: { ref: match.ref, node: match.node } };
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
  const { req, device, logPath, session } = ctx;
  if (!value) {
    return errorResponse('INVALID_ARGS', 'find type requires text');
  }
  const focusResponse = await dispatchFocusForFindMatch(ctx, match);
  if (!focusResponse.ok) return focusResponse;
  const response = await dispatchCommand(device, 'type', [value], req.flags?.out, {
    ...contextFromFlags(logPath, req.flags, session?.appBundleId, session?.trace?.outPath),
  });
  recordFindAction(ctx, match, 'type');
  return { ok: true, data: response ?? { ref: match.ref } };
}

async function dispatchFocusForFindMatch(
  ctx: FindContext,
  match: ResolvedMatch,
): Promise<DaemonResponse> {
  const { req, device, logPath, session } = ctx;
  const coveredResponse = rejectCoveredFindMatch(match, 'be focused');
  if (coveredResponse) return coveredResponse;
  const coords = match.resolvedNode.rect ? centerOfRect(match.resolvedNode.rect) : null;
  if (!coords) {
    return errorResponse('COMMAND_FAILED', 'matched element has no bounds');
  }
  const response = await dispatchCommand(
    device,
    'focus',
    [String(coords.x), String(coords.y)],
    req.flags?.out,
    {
      ...contextFromFlags(logPath, req.flags, session?.appBundleId, session?.trace?.outPath),
    },
  );
  return { ok: true, data: response ?? { ref: match.ref } };
}

function rejectCoveredFindMatch(match: ResolvedMatch, interaction: string): DaemonResponse | null {
  const blockedNode = [match.resolvedNode, match.node].find(isSnapshotNodeInteractionBlocked);
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

function buildAmbiguousMatchError(
  matches: SnapshotState['nodes'],
  locator: FindLocator,
  query: string,
): DaemonResponse {
  const candidates = matches.slice(0, 8).map((candidate) => {
    const label =
      extractNodeText(candidate) || candidate.label || candidate.identifier || candidate.type || '';
    return `@${candidate.ref}${label ? `(${label})` : ''}`;
  });
  return errorResponse(
    'AMBIGUOUS_MATCH',
    `find matched ${matches.length} elements for ${locator} "${query}". Use a more specific locator or selector.`,
    {
      locator,
      query,
      matches: matches.length,
      candidates,
    },
  );
}

function shouldScopeFind(locator: FindLocator): boolean {
  return locator !== 'role';
}
