import type { CommandFlags } from '@agent-device/contracts/command';
import {
  recordSnapshotTiming,
  snapshotCaptureAnnotationsFrom,
  type SnapshotCaptureAnnotations,
} from '@agent-device/contracts/capture';
import { isMacOs, publicPlatformString } from '@agent-device/kernel/device';
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
import { dispatchCommand } from '../../core/dispatch.ts';
import { runMacOsSnapshotAction } from '../../platforms/apple/os/macos/helper.ts';
import { snapshotLinux } from '../../platforms/linux/snapshot.ts';
import { annotateCoveredSnapshotNodes } from '../../snapshot/snapshot-occlusion.ts';
import { findNodeByLabel, resolveRefLabel } from '../../core/snapshot-node-lookup.ts';
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
  const { device, session, flags, outPath, logPath, snapshotScope } = params;
  if (device.platform === 'linux') {
    const linuxResult = await snapshotLinux(session?.surface, params.signal);
    return shapeDesktopSurfaceSnapshot(
      { nodes: linuxResult.nodes, truncated: linuxResult.truncated, backend: 'linux-atspi' },
      {
        snapshotDepth: flags?.snapshotDepth,
        snapshotInteractiveOnly: flags?.snapshotInteractiveOnly,
        snapshotScope,
      },
    );
  }
  if (isMacOs(device) && session?.surface && session.surface !== 'app') {
    const helperSnapshot = await runMacOsSnapshotAction(session.surface, {
      bundleId: session.surface === 'menubar' ? session.appBundleId : undefined,
      signal: params.signal,
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
    signal: params.signal,
  })) as SnapshotData;
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
    ? presentIosInteractiveSnapshot(scopedNodes, snapshotQuality?.backend)
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
