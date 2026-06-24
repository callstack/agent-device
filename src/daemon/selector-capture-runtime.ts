import type { BackendSnapshotResult } from '../backend.ts';
import type { CommandFlags } from '../core/dispatch.ts';
import {
  buildSnapshotPresentationKey,
  snapshotPresentationOptionsFromFlags,
  type SnapshotState,
} from '../utils/snapshot.ts';
import { isSparseSnapshotQualityVerdict } from '../utils/snapshot-quality.ts';
import type { DaemonRequest, SessionState } from './types.ts';
import { SessionStore } from './session-store.ts';
import { captureSnapshot } from './handlers/snapshot-capture.ts';
import { setSessionSnapshot } from './session-snapshot.ts';
import { getActiveAndroidSnapshotFreshness } from './android-snapshot-freshness.ts';

const SELECTOR_CAPTURE_CACHE_TTL_MS = 750;

type SelectorCaptureRuntimeParams = {
  device: SessionState['device'];
  session: SessionState | undefined;
  sessionStore: SessionStore;
  sessionName: string;
  req: DaemonRequest;
  logPath?: string;
};

/**
 * Callers opt into the cache tiers they already owned before this module:
 * find leaves session snapshots and post-gesture bypass off, selector reads enable both,
 * and polling/fresh wait captures set forceFresh.
 */
type SelectorCaptureCachePolicy = {
  forceFresh?: boolean;
  useSessionSnapshot?: boolean;
  bypassForPostGestureStabilization?: boolean;
};

type SelectorCaptureRecoveryPolicy = {
  legacyIosSparse?: {
    query: string;
    scope: string | undefined;
    shouldScope: boolean;
  };
  sparseVerdictQueryScope?: {
    query: string;
    shouldScope: boolean;
  };
};

type SelectorCaptureRequest = {
  flags: CommandFlags | undefined;
  includeRects?: boolean;
  outPath?: string;
  snapshotScope?: string;
  cache?: SelectorCaptureCachePolicy;
  recovery?: SelectorCaptureRecoveryPolicy;
};

type SelectorCaptureResult = BackendSnapshotResult & { snapshot: SnapshotState };

export function createSelectorCaptureRuntime(params: SelectorCaptureRuntimeParams) {
  const { session, sessionStore, sessionName } = params;
  let lastSnapshotAt = 0;
  let lastSnapshotResult: SelectorCaptureResult | undefined;
  let lastSnapshotCacheKey: string | undefined;

  const capture = async (request: SelectorCaptureRequest): Promise<SelectorCaptureResult> => {
    const timestamp = Date.now();
    const cacheKey = selectorCaptureCacheKey(request, params.req.flags?.out);
    const reusableLastSnapshot = readReusableLastSnapshot({
      timestamp,
      lastSnapshotAt,
      lastSnapshotResult,
      lastSnapshotCacheKey,
      session,
      request,
      cacheKey,
    });
    if (reusableLastSnapshot) {
      return reusableLastSnapshot;
    }

    const sessionSnapshot = reusableSessionSnapshot({ session, timestamp, request });
    if (sessionSnapshot) {
      lastSnapshotAt = sessionSnapshot.createdAt;
      lastSnapshotResult = { snapshot: sessionSnapshot };
      lastSnapshotCacheKey = cacheKey;
      return lastSnapshotResult;
    }

    const snapshot = await captureSelectorSnapshot({ params, request });
    const result = { snapshot };
    updateSessionSnapshot({ session, sessionStore, sessionName, snapshot });
    lastSnapshotAt = timestamp;
    lastSnapshotResult = result;
    lastSnapshotCacheKey = cacheKey;
    return result;
  };

  return { capture };
}

async function captureSelectorSnapshot(params: {
  params: SelectorCaptureRuntimeParams;
  request: SelectorCaptureRequest;
}): Promise<SnapshotState> {
  const { params: runtimeParams, request } = params;
  const snapshot = await runCapture(runtimeParams, request, request.snapshotScope);
  if (request.recovery?.legacyIosSparse && isLegacySparseIosInteractiveSnapshot(snapshot)) {
    return await recoverLegacySparseIosSnapshot({
      runtimeParams,
      request,
      policy: request.recovery.legacyIosSparse,
    });
  }
  if (
    request.recovery?.sparseVerdictQueryScope?.shouldScope &&
    isSparseSnapshotQualityVerdict(snapshot.snapshotQuality)
  ) {
    return await recoverSparseVerdictWithQueryScope({
      runtimeParams,
      request,
      policy: request.recovery.sparseVerdictQueryScope,
      snapshot,
    });
  }
  return snapshot;
}

async function recoverLegacySparseIosSnapshot(params: {
  runtimeParams: SelectorCaptureRuntimeParams;
  request: SelectorCaptureRequest;
  policy: NonNullable<SelectorCaptureRecoveryPolicy['legacyIosSparse']>;
}): Promise<SnapshotState> {
  const { runtimeParams, request, policy } = params;
  try {
    return await runCapture(runtimeParams, request, policy.scope, false);
  } catch (error) {
    if (!policy.shouldScope) throw error;
    return await runCapture(runtimeParams, request, policy.query, false);
  }
}

async function recoverSparseVerdictWithQueryScope(params: {
  runtimeParams: SelectorCaptureRuntimeParams;
  request: SelectorCaptureRequest;
  policy: NonNullable<SelectorCaptureRecoveryPolicy['sparseVerdictQueryScope']>;
  snapshot: SnapshotState;
}): Promise<SnapshotState> {
  const { runtimeParams, request, policy, snapshot } = params;
  try {
    return await runCapture(runtimeParams, request, policy.query, false);
  } catch {
    return snapshot;
  }
}

async function runCapture(
  params: SelectorCaptureRuntimeParams,
  request: SelectorCaptureRequest,
  snapshotScope: string | undefined,
  interactiveOnly = request.flags?.snapshotInteractiveOnly,
): Promise<SnapshotState> {
  const capture = await captureSnapshot({
    device: params.device,
    session: params.session,
    flags: {
      ...request.flags,
      snapshotInteractiveOnly: interactiveOnly,
    },
    outPath: request.outPath ?? params.req.flags?.out,
    logPath: params.logPath ?? '',
    snapshotScope,
    includeRects: request.includeRects,
  });
  return capture.snapshot;
}

function readReusableLastSnapshot(params: {
  timestamp: number;
  lastSnapshotAt: number;
  lastSnapshotResult: SelectorCaptureResult | undefined;
  lastSnapshotCacheKey: string | undefined;
  session: SessionState | undefined;
  request: SelectorCaptureRequest;
  cacheKey: string;
}): SelectorCaptureResult | undefined {
  const {
    timestamp,
    lastSnapshotAt,
    lastSnapshotResult,
    lastSnapshotCacheKey,
    session,
    request,
    cacheKey,
  } = params;
  if (request.cache?.forceFresh === true) return undefined;
  if (!lastSnapshotResult) return undefined;
  if (lastSnapshotCacheKey !== cacheKey) return undefined;
  if (timestamp - lastSnapshotAt >= SELECTOR_CAPTURE_CACHE_TTL_MS) return undefined;
  if (getActiveAndroidSnapshotFreshness(session)) return undefined;
  if (shouldBypassForPostGestureStabilization(session, request)) return undefined;
  return lastSnapshotResult;
}

function reusableSessionSnapshot(params: {
  session: SessionState | undefined;
  timestamp: number;
  request: SelectorCaptureRequest;
}): SnapshotState | undefined {
  const { session, timestamp, request } = params;
  const snapshot = session?.snapshot;
  if (!snapshot) return undefined;
  if (!canUseSessionSnapshotCache(session, request)) return undefined;
  if (!isFreshSelectorSnapshot(snapshot, timestamp)) return undefined;
  if (snapshot.presentationKey !== presentationKeyFor(request)) return undefined;
  return snapshot;
}

function canUseSessionSnapshotCache(
  session: SessionState,
  request: SelectorCaptureRequest,
): boolean {
  if (request.cache?.forceFresh === true) return false;
  if (request.cache?.useSessionSnapshot !== true) return false;
  if (getActiveAndroidSnapshotFreshness(session)) return false;
  if (shouldBypassForPostGestureStabilization(session, request)) return false;
  return true;
}

function isFreshSelectorSnapshot(snapshot: SnapshotState, timestamp: number): boolean {
  return timestamp - snapshot.createdAt < SELECTOR_CAPTURE_CACHE_TTL_MS;
}

function shouldBypassForPostGestureStabilization(
  session: SessionState | undefined,
  request: SelectorCaptureRequest,
): boolean {
  return (
    request.cache?.bypassForPostGestureStabilization === true &&
    Boolean(session?.postGestureStabilization)
  );
}

function presentationKeyFor(request: SelectorCaptureRequest): string {
  return buildSnapshotPresentationKey(
    snapshotPresentationOptionsFromFlags(flagsForPresentation(request)),
  );
}

function selectorCaptureCacheKey(
  request: SelectorCaptureRequest,
  defaultOutPath: string | undefined,
): string {
  return JSON.stringify({
    presentationKey: presentationKeyFor(request),
    includeRects: request.includeRects === true,
    outPath: request.outPath ?? defaultOutPath ?? null,
  });
}

function flagsForPresentation(request: SelectorCaptureRequest): CommandFlags | undefined {
  if (request.snapshotScope === undefined) return request.flags;
  return {
    ...request.flags,
    snapshotScope: request.snapshotScope,
  };
}

function updateSessionSnapshot(params: {
  session: SessionState | undefined;
  sessionStore: SessionStore;
  sessionName: string;
  snapshot: SnapshotState;
}): void {
  const { session, sessionStore, sessionName, snapshot } = params;
  if (!session || isSparseSnapshotQualityVerdict(snapshot.snapshotQuality)) return;
  setSessionSnapshot(session, snapshot);
  sessionStore.set(sessionName, session);
}

function isLegacySparseIosInteractiveSnapshot(snapshot: SnapshotState): boolean {
  if (snapshot.snapshotQuality) return false;
  if (snapshot.backend !== 'xctest' || snapshot.nodes.length !== 1) return false;
  return snapshot.nodes[0]?.type === 'Application';
}
