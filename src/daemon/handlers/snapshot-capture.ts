import type { CommandFlags } from '@agent-device/contracts/command';
import {
  recordSnapshotTiming,
  snapshotCaptureAnnotationsFrom,
  type SnapshotCaptureAnnotations,
} from '@agent-device/contracts/capture';
import { publicPlatformString } from '@agent-device/kernel/device';
import { isAndroidInputMethodNode } from '@agent-device/contracts/platform';
import {
  attachRefs,
  buildSnapshotPresentationKey,
  findNodeByRef,
  normalizeRef,
  snapshotPresentationOptionsFromFlags,
  type RawSnapshotNode,
  type SnapshotBackend,
  type SnapshotState,
} from '@agent-device/kernel/snapshot';
import { annotateCoveredSnapshotNodes } from '../../snapshot/snapshot-occlusion.ts';
import { resolveRefLabel } from '../../core/snapshot-node-lookup.ts';
import { scopeSnapshotNodes } from '../../snapshot/snapshot-desktop-surface.ts';
import { captureSnapshotWithInteractor } from './snapshot-interactor-capture.ts';
import { normalizeSnapshotTree, pruneGroupNodes } from '../../core/snapshot-tree-ingestion.ts';
import {
  clearAndroidSnapshotFreshness,
  type AndroidFreshnessMode,
} from '../android-snapshot-freshness.ts';
import { contextFromFlags } from '../context.ts';
import { resolveDeferredInteractionOutcome } from '../deferred-interaction-outcome.ts';
import { presentIosInteractiveSnapshot } from '../snapshot-presentation/ios/index.ts';
import type { SessionState } from '../types.ts';
import { errorResponse, type DaemonFailureResponse } from './response.ts';

type CaptureSnapshotParams = {
  device: SessionState['device'];
  session: SessionState | undefined;
  flags: CommandFlags | undefined;
  includeRects?: boolean;
  outPath?: string;
  logPath: string;
  snapshotScope?: string;
  androidFreshnessMode?: AndroidFreshnessMode;
  signal?: AbortSignal;
  /**
   * Request-bound platform capture. Migrated callers inject the selected
   * runtime operation; legacy consumers keep the existing interactor path
   * until their own command descriptor cuts over.
   */
  captureData?: () => Promise<SnapshotData>;
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

export async function captureSnapshot(
  params: CaptureSnapshotParams,
): Promise<CaptureSnapshotResult> {
  const deferred = await resolveDeferredInteractionOutcome({
    session: params.session,
    device: params.device,
    logPath: params.logPath,
    interactiveOnly: params.flags?.snapshotInteractiveOnly === true,
    androidFreshnessMode: params.androidFreshnessMode,
    capture: () => captureSnapshotAttempt(params),
  });
  if (deferred) return deferred;

  const latest = await captureSnapshotAttempt(params);
  clearAndroidSnapshotFreshness(params.session);
  return {
    snapshot: latest.snapshot,
    ...latest.annotations,
  };
}

export async function captureSnapshotData(params: CaptureSnapshotParams): Promise<SnapshotData> {
  if (params.captureData) return await params.captureData();
  const { device, session, flags, logPath, snapshotScope } = params;
  const context = contextFromFlags(
    logPath,
    { ...flags, snapshotScope },
    session?.appBundleId,
    session?.trace?.outPath,
  );
  return await captureSnapshotWithInteractor({
    device,
    runnerContext: {
      requestId: context.requestId,
      signal: params.signal,
      appBundleId: context.appBundleId,
      verbose: context.verbose,
      logPath: context.logPath,
      traceLogPath: context.traceLogPath,
      iosXctestrunFile: context.iosXctestrunFile,
      iosXctestDerivedDataPath: context.iosXctestDerivedDataPath,
      iosXctestEnvDir: context.iosXctestEnvDir,
      runnerLeaseContext: context.runnerLeaseContext,
    },
    options: {
      appBundleId: context.appBundleId,
      signal: params.signal,
      interactiveOnly: context.snapshotInteractiveOnly,
      preferredBackend: context.snapshotPreferredBackend,
      depth: context.snapshotDepth,
      scope: context.snapshotScope,
      raw: context.snapshotRaw,
      customActions: context.snapshotCustomActions,
      includeRects: params.includeRects,
      includeHiddenContentHints: context.snapshotIncludeHiddenContentHints,
      surface: session?.surface,
    },
  });
}

async function captureSnapshotAttempt(params: CaptureSnapshotParams): Promise<SnapshotAttempt> {
  const startedAt = Date.now();
  const data = await captureSnapshotData(params);
  recordSnapshotTiming(params.session, {
    durationMs: Date.now() - startedAt,
    backend: data.backend,
    // approach (b): emit the PUBLIC leaf platform (ios/macos), never the internal `apple`.
    platform: publicPlatformString(params.device),
  });
  const annotations = snapshotCaptureAnnotationsFrom(data);
  const snapshot = buildSnapshotState(data, resolveSnapshotStateFlags(params));
  // The one seam where snapshot state and capture annotations meet: consumers that only keep the
  // SnapshotState (selector-backed find/wait, session-stored snapshots) must still learn that the
  // capture is an occluding system surface, so the disclosure is not lost with the annotations.
  if (annotations.androidSnapshot?.systemSurfaceOnly === true) {
    snapshot.systemSurfaceOnly = true;
  }
  return { data, snapshot, annotations };
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
  const snapshotQuality = snapshotCaptureAnnotationsFrom(data).quality;
  const presentableNodes = shouldPresentIosInteractiveSnapshot(data?.backend, flags)
    ? presentIosInteractiveSnapshot(scopedNodes)
    : scopedNodes;
  const nodes = attachRefs(
    snapshotRaw
      ? presentableNodes
      : annotateCoveredSnapshotNodes(presentableNodes, {
          isAdditionalOverlayNode:
            data?.backend === 'android' ? isAndroidInputMethodNode : undefined,
        }),
  );
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
