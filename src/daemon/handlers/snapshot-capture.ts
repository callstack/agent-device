import { dispatchCommand, type CommandFlags } from '../../core/dispatch.ts';
import { sleep } from '../../utils/timeouts.ts';
import { runMacOsSnapshotAction } from '../../platforms/ios/macos-helper.ts';
import { snapshotLinux } from '../../platforms/linux/snapshot.ts';
import {
  attachRefs,
  buildSnapshotPresentationKey,
  findNodeByRef,
  normalizeRef,
  snapshotPresentationOptionsFromFlags,
  type RawSnapshotNode,
  type SnapshotBackend,
  type SnapshotState,
} from '../../utils/snapshot.ts';
import { annotateCoveredSnapshotNodes } from '../../utils/snapshot-occlusion.ts';
import { normalizeSnapshotTree } from '../../utils/snapshot-tree.ts';
export { buildSnapshotVisibility } from '../../utils/snapshot-visibility.ts';
import type { SessionState } from '../types.ts';
import {
  ANDROID_FRESHNESS_RETRY_DEADLINE_MS,
  ANDROID_FRESHNESS_RETRY_DELAYS_MS,
  clearAndroidSnapshotFreshness,
  getActiveAndroidSnapshotFreshness,
  isLikelySnapshotStuckOnPreviousRoute,
  isLikelyStaleSnapshotDrop,
  isNavigationSensitiveAction,
} from '../android-snapshot-freshness.ts';
import { contextFromFlags } from '../context.ts';
import {
  buildInteractionSurfaceSignature,
  classifyInteractionSurfaceChange,
  clearPendingInteractionOutcome,
  emitInteractionSettled,
  emitInteractionSettleTimeout,
  getActivePendingInteractionOutcome,
  retryPendingInteractionOutcome,
} from '../interaction-outcome-policy.ts';
import { capturePostGestureStabilizedResult } from '../post-gesture-stabilization.ts';
import {
  findNodeByLabel,
  pruneGroupNodes,
  resolveRefLabel,
} from '../../utils/snapshot-processing.ts';
import { errorResponse, type DaemonFailureResponse } from './response.ts';
import { presentIosInteractiveSnapshot } from '../snapshot-presentation/ios/index.ts';
import {
  snapshotCaptureAnnotationsFrom,
  type SnapshotCaptureAnnotations,
} from '../../snapshot-capture-annotations.ts';
import { recordSnapshotTiming } from '../../snapshot-diagnostics.ts';

type CaptureSnapshotParams = {
  device: SessionState['device'];
  session: SessionState | undefined;
  flags: CommandFlags | undefined;
  includeRects?: boolean;
  outPath?: string;
  logPath: string;
  snapshotScope?: string;
  androidFreshnessMode?: AndroidFreshnessMode;
};

type SnapshotData = {
  nodes?: RawSnapshotNode[];
  truncated?: boolean;
  backend?: SnapshotBackend;
  quality?: unknown;
} & Omit<SnapshotCaptureAnnotations, 'quality'>;

type SnapshotAttempt = {
  data: SnapshotData;
  snapshot: SnapshotState;
  annotations: SnapshotCaptureAnnotations;
};

type CaptureSnapshotResult = {
  snapshot: SnapshotState;
} & SnapshotCaptureAnnotations;

type AndroidFreshnessReason = 'empty-interactive' | 'sharp-drop' | 'stuck-route';
type AndroidFreshnessMode = 'default' | 'ref-refresh';
const INTERACTION_CHANGE_RECHECK_DELAY_MS = 500;

export async function captureSnapshot(
  params: CaptureSnapshotParams,
): Promise<CaptureSnapshotResult> {
  const postActionResult = await capturePostActionAwareSnapshot(params);
  if (postActionResult) return postActionResult;

  const latest = await captureSnapshotAttempt(params);
  clearAndroidSnapshotFreshness(params.session);
  return {
    snapshot: latest.snapshot,
    ...latest.annotations,
  };
}

async function capturePostActionAwareSnapshot(
  params: CaptureSnapshotParams,
): Promise<CaptureSnapshotResult | undefined> {
  const pendingInteractionOutcome = getActivePendingInteractionOutcome(params.session);
  if (pendingInteractionOutcome && params.session) {
    return await captureInteractionOutcomeAwareSnapshot(
      { ...params, session: params.session },
      pendingInteractionOutcome,
    );
  }
  if (
    (params.device.platform === 'ios' || params.device.platform === 'android') &&
    params.session?.postGestureStabilization
  ) {
    return await capturePostGestureAwareSnapshot({ ...params, session: params.session });
  }
  const freshness = getActiveAndroidSnapshotFreshness(params.session);
  if (freshness && params.device.platform === 'android') {
    return await captureAndroidFreshnessAwareSnapshot(params, freshness);
  }
  return undefined;
}

async function captureInteractionOutcomeAwareSnapshot(
  params: CaptureSnapshotParams & { session: SessionState },
  pending: NonNullable<SessionState['pendingInteractionOutcome']>,
): Promise<CaptureSnapshotResult> {
  const session = params.session;

  const startedAt = Date.now();
  let retryAttempts = 0;
  let latest = await waitForDelayedInteractionSurfaceChange(
    params,
    pending,
    await capturePostActionSnapshotAttempt(params),
  );
  let outcome = await retryPendingInteractionOutcome({
    session,
    pending,
    logPath: params.logPath,
    snapshot: latest.snapshot,
  });

  while (outcome.retried) {
    retryAttempts += 1;
    latest = await waitForDelayedInteractionSurfaceChange(
      params,
      pending,
      await capturePostActionSnapshotAttempt(params),
    );
    outcome = await retryPendingInteractionOutcome({
      session,
      pending,
      logPath: params.logPath,
      snapshot: latest.snapshot,
    });
  }

  clearPendingInteractionOutcome(session);
  latest = await capturePostGestureStabilizedResult({
    session,
    initial: latest,
    capture: async () => await capturePostActionSnapshotAttempt(params),
    readSnapshot: (attempt) => attempt.snapshot,
  });
  if (outcome.change !== 'ambiguous' && latest.annotations.freshness?.staleAfterRetries !== true) {
    clearAndroidSnapshotFreshness(session);
  }
  if (outcome.change === 'unchanged') {
    emitInteractionSettleTimeout({ pending, attempts: retryAttempts, startedAt });
  } else {
    emitInteractionSettled({
      pending,
      change: outcome.change,
      attempts: retryAttempts,
      startedAt,
    });
  }

  return {
    snapshot: latest.snapshot,
    ...latest.annotations,
  };
}

async function waitForDelayedInteractionSurfaceChange(
  params: CaptureSnapshotParams & { session: SessionState },
  pending: NonNullable<SessionState['pendingInteractionOutcome']>,
  initial: SnapshotAttempt,
): Promise<SnapshotAttempt> {
  let latest = initial;
  const change = classifyInteractionSurfaceChange(
    pending.preSignature,
    buildInteractionSurfaceSignature(latest.snapshot.nodes),
  );
  if (change !== 'unchanged') return latest;

  await sleep(INTERACTION_CHANGE_RECHECK_DELAY_MS);
  latest = await capturePostActionSnapshotAttempt(params);

  return latest;
}

export async function captureSnapshotData(params: CaptureSnapshotParams): Promise<SnapshotData> {
  const { device, session, flags, outPath, logPath, snapshotScope } = params;
  if (device.platform === 'linux') {
    const linuxResult = await snapshotLinux(session?.surface);
    return shapeDesktopSurfaceSnapshot(
      { nodes: linuxResult.nodes, truncated: linuxResult.truncated, backend: 'linux-atspi' },
      {
        snapshotDepth: flags?.snapshotDepth,
        snapshotInteractiveOnly: flags?.snapshotInteractiveOnly,
        snapshotScope,
      },
    );
  }
  if (device.platform === 'macos' && session?.surface && session.surface !== 'app') {
    const helperSnapshot = await runMacOsSnapshotAction(session.surface, {
      bundleId: session.surface === 'menubar' ? session.appBundleId : undefined,
    });
    return shapeDesktopSurfaceSnapshot(helperSnapshot, {
      snapshotDepth: flags?.snapshotDepth,
      snapshotInteractiveOnly: flags?.snapshotInteractiveOnly,
      snapshotScope,
    });
  }
  return (await dispatchCommand(device, 'snapshot', [], outPath, {
    ...contextFromFlags(
      logPath,
      { ...flags, snapshotScope },
      session?.appBundleId,
      session?.trace?.outPath,
    ),
    snapshotIncludeRects: params.includeRects,
  })) as SnapshotData;
}

async function captureAndroidFreshnessAwareSnapshot(
  params: CaptureSnapshotParams,
  freshness: NonNullable<SessionState['androidSnapshotFreshness']>,
): Promise<CaptureSnapshotResult> {
  const latest = await captureAndroidFreshnessAwareAttempt(params, freshness);
  return {
    snapshot: latest.snapshot,
    ...latest.annotations,
  };
}

async function captureAndroidFreshnessAwareAttempt(
  params: CaptureSnapshotParams,
  freshness: NonNullable<SessionState['androidSnapshotFreshness']>,
): Promise<SnapshotAttempt> {
  let latest = await captureSnapshotAttempt(params);
  let suspiciousReason = getAndroidFreshnessReason(latest, freshness, params);
  let retryCount = 0;
  const retryUntilMs = freshness.markedAt + ANDROID_FRESHNESS_RETRY_DEADLINE_MS;

  for (const delayMs of ANDROID_FRESHNESS_RETRY_DELAYS_MS) {
    if (!suspiciousReason) break;
    const remainingMs = retryUntilMs - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(delayMs, remainingMs));
    latest = await captureSnapshotAttempt(params);
    retryCount += 1;
    suspiciousReason = getAndroidFreshnessReason(latest, freshness, params);
  }

  if (!suspiciousReason) {
    clearAndroidSnapshotFreshness(params.session);
  }

  const freshnessAnnotation =
    retryCount > 0 || Boolean(suspiciousReason)
      ? {
          action: freshness.action,
          retryCount,
          staleAfterRetries: Boolean(suspiciousReason),
          reason: suspiciousReason ?? undefined,
        }
      : undefined;
  return {
    ...latest,
    annotations: {
      ...latest.annotations,
      ...snapshotCaptureAnnotationsFrom({ freshness: freshnessAnnotation }),
    },
  };
}

async function capturePostGestureAwareSnapshot(
  params: CaptureSnapshotParams & { session: SessionState },
): Promise<CaptureSnapshotResult> {
  const latest = await capturePostGestureStabilizedResult({
    session: params.session,
    capture: async () => await capturePostActionSnapshotAttempt(params),
    readSnapshot: (attempt) => attempt.snapshot,
  });
  return {
    snapshot: latest.snapshot,
    ...latest.annotations,
  };
}

async function capturePostActionSnapshotAttempt(
  params: CaptureSnapshotParams & { session: SessionState },
): Promise<SnapshotAttempt> {
  const freshness = getActiveAndroidSnapshotFreshness(params.session);
  if (freshness && params.device.platform === 'android') {
    return await captureAndroidFreshnessAwareAttempt(params, freshness);
  }
  return await captureSnapshotAttempt(params);
}

async function captureSnapshotAttempt(params: CaptureSnapshotParams): Promise<SnapshotAttempt> {
  const startedAt = Date.now();
  const data = await captureSnapshotData(params);
  recordSnapshotTiming(params.session, {
    durationMs: Date.now() - startedAt,
    backend: data.backend,
    platform: params.device.platform,
  });
  return {
    data,
    snapshot: buildSnapshotState(data, resolveSnapshotStateFlags(params)),
    annotations: snapshotCaptureAnnotationsFrom(data),
  };
}

function resolveSnapshotStateFlags(
  params: Pick<CaptureSnapshotParams, 'flags' | 'snapshotScope'>,
): CaptureSnapshotParams['flags'] {
  if (params.snapshotScope === undefined) {
    return params.flags;
  }
  return {
    ...params.flags,
    snapshotScope: params.snapshotScope,
  };
}

function getAndroidFreshnessReason(
  attempt: SnapshotAttempt,
  freshness: NonNullable<SessionState['androidSnapshotFreshness']>,
  params: Pick<CaptureSnapshotParams, 'flags' | 'androidFreshnessMode'>,
): AndroidFreshnessReason | null {
  const interactiveOnly = params.flags?.snapshotInteractiveOnly === true;
  const analysis = attempt.annotations.analysis;

  // When interactive-only filtering produces zero visible nodes from ≥12 raw nodes,
  // the dump likely captured a transitional frame.  The 12-node floor avoids
  // false positives on deliberately minimal screens (splash, loading).
  if (
    interactiveOnly &&
    attempt.snapshot.nodes.length === 0 &&
    analysis &&
    analysis.rawNodeCount >= 12
  ) {
    return 'empty-interactive';
  }

  if (params.androidFreshnessMode === 'ref-refresh') {
    return null;
  }

  if (isLikelyStaleSnapshotDrop(freshness.baselineCount, attempt.snapshot.nodes.length)) {
    return !hasMeaningfulSnapshotContent(attempt.snapshot) ? 'sharp-drop' : null;
  }

  return freshness.routeComparable &&
    isNavigationSensitiveAction(freshness.action) &&
    isLikelySnapshotStuckOnPreviousRoute(freshness.baselineSignatures, attempt.snapshot.nodes)
    ? 'stuck-route'
    : null;
}

function hasMeaningfulSnapshotContent(snapshot: SnapshotState): boolean {
  return snapshot.nodes.some(
    (node) =>
      node.hittable === true ||
      Boolean(node.label?.trim()) ||
      Boolean(node.value?.trim()) ||
      Boolean(node.identifier?.trim()),
  );
}

export function buildSnapshotState(
  data: {
    nodes?: RawSnapshotNode[];
    truncated?: boolean;
    backend?: SnapshotBackend;
    quality?: unknown;
  },
  flags:
    | (Pick<CommandFlags, 'snapshotDepth' | 'snapshotInteractiveOnly' | 'snapshotRaw'> &
        Partial<Pick<CommandFlags, 'snapshotScope'>>)
    | undefined,
): SnapshotState {
  const rawNodes = data?.nodes ?? [];
  const snapshotRaw = flags?.snapshotRaw;
  const normalizedNodes = normalizeSnapshotTree(snapshotRaw ? rawNodes : pruneGroupNodes(rawNodes));
  const scopedNodes =
    flags?.snapshotScope && data?.backend !== 'macos-helper'
      ? scopeSnapshotNodes(normalizedNodes, flags.snapshotScope)
      : normalizedNodes;
  const presentableNodes = shouldPresentIosInteractiveSnapshot(data?.backend, flags)
    ? presentIosInteractiveSnapshot(scopedNodes)
    : scopedNodes;
  const nodes = attachRefs(
    snapshotRaw ? presentableNodes : annotateCoveredSnapshotNodes(presentableNodes),
  );
  const snapshotQuality = snapshotCaptureAnnotationsFrom(data).quality;
  return {
    nodes,
    truncated: data?.truncated,
    createdAt: Date.now(),
    backend: data?.backend,
    ...(snapshotQuality ? { snapshotQuality } : {}),
    presentationKey: buildSnapshotPresentationKey(snapshotPresentationOptionsFromFlags(flags)),
    // Only broad Android snapshots become freshness baselines. If the user asked for a scoped
    // or filtered view, preserve that output contract but avoid pretending it is safe for
    // route-level comparisons on the next capture.
    comparisonSafe: isAndroidComparisonSafeSnapshot(data?.backend, flags),
  };
}

function shouldPresentIosInteractiveSnapshot(
  backend: SnapshotBackend | undefined,
  flags:
    | (Pick<CommandFlags, 'snapshotDepth' | 'snapshotInteractiveOnly' | 'snapshotRaw'> &
        Partial<Pick<CommandFlags, 'snapshotScope'>>)
    | undefined,
): boolean {
  return (
    backend === 'xctest' && flags?.snapshotInteractiveOnly === true && flags.snapshotRaw !== true
  );
}

function isAndroidComparisonSafeSnapshot(
  backend: SnapshotBackend | undefined,
  flags:
    | (Pick<CommandFlags, 'snapshotDepth' | 'snapshotInteractiveOnly' | 'snapshotRaw'> &
        Partial<Pick<CommandFlags, 'snapshotScope'>>)
    | undefined,
): boolean {
  return (
    backend === 'android' &&
    flags?.snapshotInteractiveOnly !== true &&
    typeof flags?.snapshotDepth !== 'number' &&
    !flags?.snapshotScope
  );
}

function shapeDesktopSurfaceSnapshot(
  data: SnapshotData,
  options: {
    snapshotDepth?: number;
    snapshotInteractiveOnly?: boolean;
    snapshotScope?: string;
  },
): SnapshotData {
  let nodes = data.nodes ?? [];
  if (options.snapshotScope) {
    nodes = scopeSnapshotNodes(nodes, options.snapshotScope);
  }
  if (options.snapshotInteractiveOnly) {
    nodes = filterInteractiveSnapshotNodes(nodes);
  }
  if (typeof options.snapshotDepth === 'number') {
    nodes = filterSnapshotNodesByDepth(nodes, options.snapshotDepth);
  }
  return { ...data, nodes };
}

function scopeSnapshotNodes(nodes: RawSnapshotNode[], scope: string): RawSnapshotNode[] {
  const scopedNodes = attachRefs(nodes);
  const match = findNodeByLabel(scopedNodes, scope);
  if (!match) {
    return [];
  }
  const startIndex = nodes.findIndex((node) => node.index === match.index);
  if (startIndex === -1) {
    return [];
  }
  const startDepth = nodes[startIndex]?.depth ?? 0;
  const slice: RawSnapshotNode[] = [];
  for (let index = startIndex; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    const depth = node.depth ?? 0;
    if (index > startIndex && depth <= startDepth) {
      break;
    }
    slice.push(node);
  }
  return reindexSnapshotNodes(slice, startDepth);
}

function filterInteractiveSnapshotNodes(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  if (nodes.length === 0) {
    return nodes;
  }
  const byIndex = new Map<number, RawSnapshotNode>();
  for (const node of nodes) {
    byIndex.set(node.index, node);
  }
  const keepIndexes = new Set<number>();
  for (const node of nodes) {
    if (!isInteractiveSnapshotNode(node)) continue;
    let current: RawSnapshotNode | undefined = node;
    while (current) {
      if (keepIndexes.has(current.index)) break;
      keepIndexes.add(current.index);
      current =
        typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
    }
  }
  if (keepIndexes.size === 0) {
    return nodes;
  }
  return reindexSnapshotNodes(nodes.filter((node) => keepIndexes.has(node.index)));
}

function filterSnapshotNodesByDepth(nodes: RawSnapshotNode[], maxDepth: number): RawSnapshotNode[] {
  return reindexSnapshotNodes(nodes.filter((node) => (node.depth ?? 0) <= maxDepth));
}

function reindexSnapshotNodes(nodes: RawSnapshotNode[], depthOffset = 0): RawSnapshotNode[] {
  const indexMap = new Map<number, number>();
  for (const [index, node] of nodes.entries()) {
    indexMap.set(node.index, index);
  }
  return nodes.map((node, index) => ({
    ...node,
    index,
    depth: Math.max(0, (node.depth ?? 0) - depthOffset),
    parentIndex: typeof node.parentIndex === 'number' ? indexMap.get(node.parentIndex) : undefined,
  }));
}

function isInteractiveSnapshotNode(node: RawSnapshotNode): boolean {
  if (node.focused) return true;
  if (node.hittable) return true;
  if (node.rect) return true;
  const role = `${node.type ?? ''} ${node.role ?? ''} ${node.subrole ?? ''}`.toLowerCase();
  return (
    role.includes('button') ||
    role.includes('menu') ||
    role.includes('textfield') ||
    role.includes('searchfield') ||
    role.includes('checkbox') ||
    role.includes('radio') ||
    role.includes('switch')
  );
}

export function resolveSnapshotScope(
  snapshotScope: string | undefined,
  session: SessionState | undefined,
): { ok: true; scope?: string } | DaemonFailureResponse {
  if (!snapshotScope || !snapshotScope.trim().startsWith('@')) {
    return { ok: true, scope: snapshotScope };
  }
  if (!session?.snapshot) {
    return errorResponse('INVALID_ARGS', 'Ref scope requires an existing snapshot in session.');
  }
  const ref = normalizeRef(snapshotScope.trim());
  if (!ref) {
    return errorResponse('INVALID_ARGS', `Invalid ref scope: ${snapshotScope}`);
  }
  const candidates = [
    session.snapshot,
    ...(session.snapshotScopeSource ? [session.snapshotScopeSource] : []),
  ];
  let resolved: string | undefined;
  for (const snapshot of candidates) {
    const node = findNodeByRef(snapshot.nodes, ref);
    resolved = node ? resolveRefLabel(node, snapshot.nodes) : undefined;
    if (resolved) break;
  }
  if (!resolved) {
    return errorResponse('COMMAND_FAILED', `Ref ${snapshotScope} not found or has no label`);
  }
  return { ok: true, scope: resolved };
}
