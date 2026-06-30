import type { BackendSnapshotResult } from '../../../backend.ts';
import type { SnapshotDiagnosticsSummary } from '../../../snapshot-diagnostics.ts';
import type { AgentDeviceRuntime, CommandSessionRecord } from '../../../runtime-contract.ts';
import {
  publicSnapshotCaptureAnnotations,
  snapshotCaptureAnnotationsFrom,
  type PublicSnapshotCaptureAnnotations,
  type SnapshotCaptureAnnotations,
} from '../../../snapshot-capture-annotations.ts';
import { renderSnapshotQualityWarnings } from '../../../snapshot/snapshot-quality.ts';
import { AppError } from '../../../kernel/errors.ts';
import {
  buildSnapshotDiff,
  countSnapshotComparableLines,
} from '../../../snapshot/snapshot-diff.ts';
import type { SnapshotDiffLine, SnapshotDiffSummary } from '../../../snapshot/snapshot-diff.ts';
import type {
  SnapshotNode,
  SnapshotState,
  SnapshotUnchanged,
  SnapshotVisibility,
} from '../../../kernel/snapshot.ts';
import { buildSnapshotVisibility } from '../../../snapshot/snapshot-visibility.ts';
import { formatReactNativeOverlayWarning } from '../../react-native/overlay.ts';
import {
  buildUnchangedSnapshotMetadata,
  ensureSnapshotPresentationKey,
} from './snapshot-unchanged.ts';
import type {
  DiffSnapshotCommandOptions,
  RuntimeCommand,
  SnapshotCommandOptions,
} from '../../runtime-types.ts';
import { now } from '../../runtime-common.ts';

export type { SnapshotDiffLine, SnapshotDiffSummary } from '../../../snapshot/snapshot-diff.ts';

export type SnapshotCommandResult = {
  nodes: SnapshotNode[];
  truncated: boolean;
  appName?: string;
  appBundleId?: string;
  visibility?: SnapshotVisibility;
  unchanged?: SnapshotUnchanged;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
} & PublicSnapshotCaptureAnnotations;

export type DiffSnapshotCommandResult = {
  mode: 'snapshot';
  baselineInitialized: boolean;
  summary: SnapshotDiffSummary;
  lines: SnapshotDiffLine[];
  warnings?: string[];
};

type SnapshotCapture = {
  snapshot: SnapshotState;
  result: BackendSnapshotResult;
  session: CommandSessionRecord | undefined;
  annotations: SnapshotCaptureAnnotations;
  warnings: string[];
};

export const snapshotCommand: RuntimeCommand<
  SnapshotCommandOptions,
  SnapshotCommandResult
> = async (runtime, options): Promise<SnapshotCommandResult> => {
  const capture = await captureRuntimeSnapshot(runtime, options);
  const unchanged = buildUnchangedSnapshotMetadata({
    previous: capture.session?.snapshot,
    current: capture.snapshot,
    options,
    identity: {
      previousAppBundleId: capture.session?.appBundleId,
      currentAppBundleId: capture.result.appBundleId ?? capture.session?.appBundleId,
    },
  });
  await runtime.sessions.set(nextSnapshotSession(options.session, capture));
  return {
    nodes: capture.snapshot.nodes,
    truncated: capture.snapshot.truncated ?? false,
    visibility: buildSnapshotVisibility({
      nodes: capture.snapshot.nodes,
      backend: capture.snapshot.backend,
      snapshotRaw: options.raw,
    }),
    ...publicSnapshotCaptureAnnotations({
      ...capture.annotations,
      warnings: capture.warnings,
    }),
    ...(unchanged ? { unchanged } : {}),
    ...(capture.result.snapshotDiagnostics
      ? { snapshotDiagnostics: capture.result.snapshotDiagnostics }
      : {}),
    ...snapshotAppFields(capture),
  };
};

export const diffSnapshotCommand: RuntimeCommand<
  DiffSnapshotCommandOptions,
  DiffSnapshotCommandResult
> = async (runtime, options): Promise<DiffSnapshotCommandResult> => {
  const capture = await captureRuntimeSnapshot(runtime, options);
  const flattenForDiff = options.interactiveOnly === true;
  const previousSnapshot = capture.session?.snapshot;
  const nextSession = nextSnapshotSession(options.session, capture);

  if (!previousSnapshot) {
    const unchanged = countSnapshotComparableLines(capture.snapshot.nodes, {
      flatten: flattenForDiff,
    });
    await runtime.sessions.set(nextSession);
    return {
      mode: 'snapshot',
      baselineInitialized: true,
      summary: {
        additions: 0,
        removals: 0,
        unchanged,
      },
      lines: [],
      ...(capture.warnings.length > 0 ? { warnings: capture.warnings } : {}),
    };
  }

  const diff = buildSnapshotDiff(previousSnapshot.nodes, capture.snapshot.nodes, {
    flatten: flattenForDiff,
  });
  await runtime.sessions.set(nextSession);
  return {
    mode: 'snapshot',
    baselineInitialized: false,
    summary: diff.summary,
    lines: diff.lines,
    ...(capture.warnings.length > 0 ? { warnings: capture.warnings } : {}),
  };
};

async function captureRuntimeSnapshot(
  runtime: AgentDeviceRuntime,
  options: SnapshotCommandOptions,
): Promise<SnapshotCapture> {
  if (!runtime.backend.captureSnapshot) {
    throw new AppError('UNSUPPORTED_OPERATION', 'snapshot is not supported by this backend');
  }

  const sessionName = options.session ?? 'default';
  const session = await runtime.sessions.get(sessionName);
  const result = await runtime.backend.captureSnapshot(
    {
      session: sessionName,
      requestId: options.requestId,
      appId: session?.appId,
      appBundleId: session?.appBundleId,
      signal: options.signal ?? runtime.signal,
      metadata: options.metadata,
    },
    {
      interactiveOnly: options.interactiveOnly,
      depth: options.depth,
      scope: options.scope,
      raw: options.raw,
    },
  );
  const snapshot = ensureSnapshotPresentationKey(
    normalizeBackendSnapshot(result, runtime),
    options,
  );
  const annotations = snapshotCaptureAnnotationsFrom(result);
  const warningTime = now(runtime);
  return {
    snapshot,
    result,
    session,
    annotations,
    warnings: buildSnapshotWarnings({
      result,
      annotations,
      snapshot,
      options,
      session,
      capturedAt: snapshot.createdAt ?? warningTime,
      runtimeNow: warningTime,
    }),
  };
}

function normalizeBackendSnapshot(
  result: BackendSnapshotResult,
  runtime: AgentDeviceRuntime,
): SnapshotState {
  if (result.snapshot) return result.snapshot;
  return {
    nodes: result.nodes ?? [],
    truncated: result.truncated,
    backend: result.backend as SnapshotState['backend'],
    createdAt: now(runtime),
  };
}

function nextSnapshotSession(
  requestedName: string | undefined,
  capture: SnapshotCapture,
): CommandSessionRecord {
  const name = capture.session?.name ?? requestedName ?? 'default';
  return {
    ...(capture.session ?? { name }),
    name,
    snapshot: capture.snapshot,
    appName: capture.result.appName ?? capture.session?.appName,
    appBundleId: capture.result.appBundleId ?? capture.session?.appBundleId,
  };
}

function snapshotAppFields(capture: SnapshotCapture): {
  appName?: string;
  appBundleId?: string;
} {
  const appName = capture.result.appName ?? capture.session?.appName;
  const appBundleId = capture.result.appBundleId ?? capture.session?.appBundleId;
  return {
    ...(appName || appBundleId ? { appName: appName ?? appBundleId } : {}),
    ...(appBundleId ? { appBundleId } : {}),
  };
}

function buildSnapshotWarnings(params: {
  result: BackendSnapshotResult;
  annotations: SnapshotCaptureAnnotations;
  snapshot: SnapshotState;
  options: SnapshotCommandOptions;
  session: CommandSessionRecord | undefined;
  capturedAt: number;
  runtimeNow: number;
}): string[] {
  const warnings = [...(params.annotations.warnings ?? [])];
  if (params.annotations.quality) {
    warnings.push(
      ...renderSnapshotQualityWarnings(params.annotations.quality, params.snapshot.nodes),
    );
  }
  warnings.push(...buildEmptyAndroidInteractiveWarnings(params));
  if (!params.annotations.quality) {
    // Legacy runners without a structured verdict keep the old daemon-side heuristics.
    warnings.push(...buildSparseIosInteractiveWarnings(params));
    warnings.push(...buildMergedAccessibilityLeafWarnings(params.snapshot.nodes));
  }

  const helperFallbackWarning = formatAndroidHelperFallbackWarning(
    params.annotations.androidSnapshot,
  );
  if (helperFallbackWarning) warnings.push(helperFallbackWarning);

  const reactNativeOverlayWarning = formatReactNativeOverlayWarning(params.snapshot.nodes);
  if (reactNativeOverlayWarning) warnings.push(reactNativeOverlayWarning);

  const recentDropWarning = formatRecentSnapshotDropWarning(params);
  if (recentDropWarning) warnings.push(recentDropWarning);

  warnings.push(...formatFreshnessWarnings(params.annotations.freshness, params.snapshot.backend));
  return Array.from(new Set(warnings));
}

function buildSparseIosInteractiveWarnings(params: {
  snapshot: SnapshotState;
  options: SnapshotCommandOptions;
}): string[] {
  if (
    params.snapshot.backend !== 'xctest' ||
    params.options.interactiveOnly !== true ||
    params.snapshot.nodes.length !== 1
  ) {
    return [];
  }

  const root = params.snapshot.nodes[0];
  if (root?.type !== 'Application') return [];

  return [
    'iOS interactive snapshot exposed only the application root. XCTest accessibility queries can fail to enumerate some simulator UI trees even when screenshots and direct gestures still work. Use screenshot as visual truth, try a scoped/full snapshot for diagnostics, and prefer direct selectors when known.',
  ];
}

const MERGED_LEAF_MIN_SEGMENTS = 10;

/**
 * A leaf whose label joins many short segments is the signature of a container marked as an
 * accessibility element: the platform folds every descendant into one merged node, so the
 * children exist on screen but cannot be addressed by assistive tech or automation. This is
 * an app-side accessibility bug, not a snapshot failure — the same merged element is all
 * VoiceOver users get.
 */
function buildMergedAccessibilityLeafWarnings(nodes: SnapshotState['nodes']): string[] {
  const parents = new Set(
    nodes.map((node) => node.parentIndex).filter((index) => index !== undefined),
  );
  return nodes
    .filter((node) => {
      if (parents.has(node.index)) return false;
      const type = node.type?.toLowerCase() ?? '';
      if (type.includes('text')) return false;
      const label = node.label ?? '';
      return label.split(', ').length > MERGED_LEAF_MIN_SEGMENTS;
    })
    .map((node) => {
      const segments = (node.label ?? '').split(', ').length;
      const name = node.identifier ? ` (${node.identifier})` : '';
      return `@${node.ref} [${node.type ?? 'element'}]${name} merges ~${segments} labels into a single accessibility element. The app likely marks a container as accessible, which hides every descendant from assistive tech and automation — the children cannot be addressed individually. Fix the app's accessibility (mark the rows, not the container); until then use screenshot as visual truth and coordinate taps.`;
    });
}

// fallow-ignore-next-line complexity
function buildEmptyAndroidInteractiveWarnings(params: {
  annotations: SnapshotCaptureAnnotations;
  snapshot: SnapshotState;
  options: SnapshotCommandOptions;
}): string[] {
  const analysis = params.annotations.analysis;
  if (
    params.snapshot.backend !== 'android' ||
    params.options.interactiveOnly !== true ||
    params.snapshot.nodes.length > 0 ||
    !analysis ||
    (analysis.rawNodeCount ?? 0) < 12
  ) {
    return [];
  }

  const warnings = [
    `Interactive snapshot is empty after filtering ${analysis.rawNodeCount} raw Android nodes. Likely causes: the app content is not accessibility-visible yet, a transient route change, or depth/filter options hid the target.`,
  ];
  if (
    typeof params.options.depth === 'number' &&
    typeof analysis.maxDepth === 'number' &&
    analysis.maxDepth >= params.options.depth + 2
  ) {
    warnings.push(
      `Interactive output is empty at depth ${params.options.depth}; retry without -d.`,
    );
  }
  return warnings;
}

function formatAndroidHelperFallbackWarning(
  androidSnapshot: SnapshotCaptureAnnotations['androidSnapshot'],
): string | undefined {
  if (androidSnapshot?.backend !== 'uiautomator-dump') return undefined;
  const reason = androidSnapshot.fallbackReason ? ` Reason: ${androidSnapshot.fallbackReason}` : '';
  return `Android snapshot helper unavailable; using stock UIAutomator dump, which can time out on busy React Native UIs.${reason}`;
}

function formatRecentSnapshotDropWarning(params: {
  annotations: SnapshotCaptureAnnotations;
  snapshot: SnapshotState;
  session: CommandSessionRecord | undefined;
  capturedAt: number;
  runtimeNow: number;
}): string | undefined {
  const previousSnapshot = params.session?.snapshot;
  if (
    !params.annotations.freshness &&
    previousSnapshot &&
    hasSameSnapshotPresentation(previousSnapshot, params.snapshot) &&
    isRecentSnapshot(previousSnapshot, params.capturedAt, params.runtimeNow) &&
    isLikelyStaleSnapshotDrop(previousSnapshot.nodes.length, params.snapshot.nodes.length)
  ) {
    return STALE_SNAPSHOT_DROP_WARNING;
  }
  return undefined;
}

function hasSameSnapshotPresentation(
  previousSnapshot: Pick<SnapshotState, 'presentationKey'>,
  snapshot: Pick<SnapshotState, 'presentationKey'>,
): boolean {
  if (previousSnapshot.presentationKey === undefined || snapshot.presentationKey === undefined) {
    return true;
  }
  return previousSnapshot.presentationKey === snapshot.presentationKey;
}

function isRecentSnapshot(
  previousSnapshot: Pick<SnapshotState, 'createdAt'>,
  capturedAt: number,
  runtimeNow: number,
): boolean {
  return [capturedAt, runtimeNow].some((timestamp) => {
    const elapsed = timestamp - previousSnapshot.createdAt;
    return elapsed >= 0 && elapsed <= 2_000;
  });
}

const STALE_SNAPSHOT_DROP_WARNING =
  'Recent snapshots dropped sharply in node count, which suggests stale or mid-transition UI. Use screenshot as visual truth, wait briefly, then re-snapshot once.';

function formatFreshnessWarnings(
  freshness: BackendSnapshotResult['freshness'],
  backend: SnapshotState['backend'],
): string[] {
  if (!freshness?.staleAfterRetries || backend !== 'android') return [];
  if (freshness.reason === 'stuck-route') {
    return [
      `Recent ${freshness.action} was followed by a nearly identical snapshot after ${freshness.retryCount} automatic retr${freshness.retryCount === 1 ? 'y' : 'ies'}. If you expected navigation or submit, the tree may still be stale. Use screenshot as visual truth, wait briefly, then re-snapshot once.`,
    ];
  }
  return freshness.reason === 'sharp-drop' ? [STALE_SNAPSHOT_DROP_WARNING] : [];
}

function isLikelyStaleSnapshotDrop(previousCount: number, currentCount: number): boolean {
  if (previousCount < 12) return false;
  return currentCount <= Math.floor(previousCount * 0.2);
}
