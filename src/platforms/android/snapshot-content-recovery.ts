import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';
import { isAndroidInputMethodOwnedNode } from '../../contracts/android-input-ownership.ts';
import { isAndroidSystemChromeResourceId } from '../../contracts/android-system-chrome.ts';
import { classifyAndroidAlertIdentifier } from './alert-detection.ts';
import { androidUiNodes, type AndroidUiNodeMetadata } from './ui-hierarchy.ts';

const ANDROID_WINDOW_TYPE_APPLICATION = 1;
const MAX_REPORTED_WINDOW_TYPES = 8;
const MIN_FOREGROUND_APP_MEANINGFUL_NODES = 2;
const MIN_INPUT_METHOD_MEANINGFUL_NODES = 2;
const MIN_SYSTEM_SURFACE_MEANINGFUL_NODES = 3;
const ANDROID_SYSTEM_PACKAGES = new Set(['android', 'com.android.systemui']);
const INSUFFICIENT_APP_CONTENT_REASON =
  'Android snapshot helper returned insufficient application window content';

export type AndroidHelperContentRecoveryDecision = {
  reason: 'empty-helper-output' | 'system-window-only' | 'content-poor-app-window';
  failureReason: string;
  diagnostics: {
    helperNodeCount: number;
    helperSystemUiNodeCount: number;
    helperWindowRootCount: number;
    helperApplicationWindowRootCount: number;
    helperMeaningfulNodeCount: number;
    helperApplicationMeaningfulNodeCount: number;
    helperNonSystemMeaningfulNodeCount: number;
    helperInputMethodMeaningfulNodeCount: number;
    helperForegroundAppMeaningfulNodeCount?: number;
    helperForegroundAppPackage?: string;
    helperForegroundAppMeaningfulNodeThreshold?: number;
    helperWindowTypes: number[];
    helperCaptureMode?: AndroidSnapshotBackendMetadata['captureMode'];
  };
};

export type AndroidHelperContentClassification =
  | { outcome: 'ok' }
  | { outcome: 'system-surface-only' }
  | { outcome: 'unusable'; decision: AndroidHelperContentRecoveryDecision };

export function classifyAndroidHelperContent(
  xml: string,
  metadata: AndroidSnapshotBackendMetadata,
  options: { foregroundAppPackage?: string } = {},
): AndroidHelperContentClassification {
  if (metadata.backend !== 'android-helper') return { outcome: 'ok' };

  const summary = summarizeAndroidHelperXml(xml, options.foregroundAppPackage);
  if (isEmptyHelperOutput(summary, metadata)) {
    return unusable(
      summary,
      metadata,
      'empty-helper-output',
      'Android snapshot helper returned no accessibility nodes',
    );
  }

  if (hasRecognizedAndroidAlertSurface(summary)) return { outcome: 'ok' };
  // Notification shade, quick settings, and similar overlays legitimately own the whole screen:
  // no application window is interactive, but the system surface carries real content. That
  // capture is the truth, so it must be returned rather than classified as a helper failure.
  if (isScreenOwnedByMeaningfulSystemSurface(summary)) return { outcome: 'system-surface-only' };
  if (isForegroundAppContentHiddenByInputMethod(summary)) return { outcome: 'ok' };
  if (isForegroundAppContentPoor(summary)) {
    return unusable(
      summary,
      metadata,
      'content-poor-app-window',
      'Android snapshot helper returned insufficient foreground app content',
    );
  }

  if (isApplicationWindowContentPoor(summary)) {
    return unusable(summary, metadata, 'content-poor-app-window', INSUFFICIENT_APP_CONTENT_REASON);
  }

  if (isWindowlessMultiWindowContentPoor(summary, metadata)) {
    return unusable(summary, metadata, 'content-poor-app-window', INSUFFICIENT_APP_CONTENT_REASON);
  }

  if (isSystemWindowOnly(summary)) {
    return unusable(
      summary,
      metadata,
      'system-window-only',
      'Android snapshot helper returned only non-application windows',
    );
  }

  return { outcome: 'ok' };
}

function unusable(
  summary: AndroidHelperXmlSummary,
  metadata: AndroidSnapshotBackendMetadata,
  reason: AndroidHelperContentRecoveryDecision['reason'],
  failureReason: string,
): AndroidHelperContentClassification {
  return {
    outcome: 'unusable',
    decision: buildRecoveryDecision(summary, metadata, reason, failureReason),
  };
}

function isScreenOwnedByMeaningfulSystemSurface(summary: AndroidHelperXmlSummary): boolean {
  return (
    summary.windowRootCount > 0 &&
    summary.applicationWindowRootCount === 0 &&
    summary.activeSystemSurfaceMeaningfulNodeCount >= MIN_SYSTEM_SURFACE_MEANINGFUL_NODES
  );
}

function isEmptyHelperOutput(
  summary: AndroidHelperXmlSummary,
  metadata: AndroidSnapshotBackendMetadata,
): boolean {
  return summary.nodeCount === 0 || metadata.nodeCount === 0 || metadata.rootPresent === false;
}

function isForegroundAppContentHiddenByInputMethod(summary: AndroidHelperXmlSummary): boolean {
  return (
    isForegroundAppContentPoor(summary) &&
    summary.inputMethodMeaningfulNodeCount >= MIN_INPUT_METHOD_MEANINGFUL_NODES
  );
}

function isForegroundAppContentPoor(summary: AndroidHelperXmlSummary): boolean {
  const foregroundCount = summary.foregroundAppMeaningfulNodeCount;
  if (foregroundCount === undefined) return false;
  if (foregroundCount === 0) {
    return summary.applicationMeaningfulNodeCount < MIN_FOREGROUND_APP_MEANINGFUL_NODES;
  }
  return (
    foregroundCount < MIN_FOREGROUND_APP_MEANINGFUL_NODES &&
    summary.meaningfulNodeCount > foregroundCount
  );
}

function isApplicationWindowContentPoor(summary: AndroidHelperXmlSummary): boolean {
  return (
    summary.foregroundAppMeaningfulNodeCount === undefined &&
    summary.applicationWindowRootCount > 0 &&
    summary.applicationMeaningfulNodeCount < MIN_FOREGROUND_APP_MEANINGFUL_NODES
  );
}

function isWindowlessMultiWindowContentPoor(
  summary: AndroidHelperXmlSummary,
  metadata: AndroidSnapshotBackendMetadata,
): boolean {
  return (
    summary.foregroundAppMeaningfulNodeCount === undefined &&
    summary.windowRootCount === 0 &&
    (metadata.windowCount ?? 0) > 1 &&
    summary.nonSystemMeaningfulNodeCount < MIN_FOREGROUND_APP_MEANINGFUL_NODES
  );
}

function isSystemWindowOnly(summary: AndroidHelperXmlSummary): boolean {
  return (
    (summary.windowRootCount > 0 && summary.applicationWindowRootCount === 0) ||
    (summary.windowRootCount === 0 &&
      summary.nodeCount > 0 &&
      summary.systemUiNodeCount === summary.nodeCount)
  );
}

function hasRecognizedAndroidAlertSurface(summary: AndroidHelperXmlSummary): boolean {
  return summary.hasAlertButtonIdentifier && summary.hasAlertContentIdentifier;
}

function buildRecoveryDecision(
  summary: AndroidHelperXmlSummary,
  metadata: AndroidSnapshotBackendMetadata,
  reason: AndroidHelperContentRecoveryDecision['reason'],
  failureReason: string,
): AndroidHelperContentRecoveryDecision {
  return {
    reason,
    failureReason,
    diagnostics: buildRecoveryDiagnostics(summary, metadata),
  };
}

type AndroidHelperXmlSummary = {
  nodeCount: number;
  systemUiNodeCount: number;
  windowRootCount: number;
  applicationWindowRootCount: number;
  activeSystemSurfaceMeaningfulNodeCount: number;
  meaningfulNodeCount: number;
  applicationMeaningfulNodeCount: number;
  nonSystemMeaningfulNodeCount: number;
  inputMethodMeaningfulNodeCount: number;
  hasAlertButtonIdentifier: boolean;
  hasAlertContentIdentifier: boolean;
  foregroundAppPackage?: string;
  foregroundAppMeaningfulNodeCount?: number;
  windowTypes: number[];
};

type AndroidHelperXmlSummaryState = Omit<AndroidHelperXmlSummary, 'windowTypes'> & {
  currentWindowType?: number;
  currentWindowActiveOrFocused?: boolean;
  windowTypes: Set<number>;
};

function summarizeAndroidHelperXml(
  xml: string,
  foregroundAppPackage: string | undefined,
): AndroidHelperXmlSummary {
  const summary = createAndroidHelperXmlSummaryState(foregroundAppPackage);

  for (const node of androidUiNodes(xml)) {
    recordAndroidHelperSummaryNode(summary, node);
  }

  return finalizeAndroidHelperXmlSummary(summary);
}

function createAndroidHelperXmlSummaryState(
  foregroundAppPackage: string | undefined,
): AndroidHelperXmlSummaryState {
  return {
    nodeCount: 0,
    systemUiNodeCount: 0,
    windowRootCount: 0,
    applicationWindowRootCount: 0,
    activeSystemSurfaceMeaningfulNodeCount: 0,
    meaningfulNodeCount: 0,
    applicationMeaningfulNodeCount: 0,
    nonSystemMeaningfulNodeCount: 0,
    inputMethodMeaningfulNodeCount: 0,
    hasAlertButtonIdentifier: false,
    hasAlertContentIdentifier: false,
    ...(foregroundAppPackage !== undefined
      ? { foregroundAppPackage, foregroundAppMeaningfulNodeCount: 0 }
      : {}),
    windowTypes: new Set<number>(),
  };
}

function recordAndroidHelperSummaryNode(
  summary: AndroidHelperXmlSummaryState,
  node: AndroidUiNodeMetadata,
): void {
  summary.nodeCount += 1;
  if (isExplicitAndroidSystemPackage(node.packageName)) summary.systemUiNodeCount += 1;
  if (node.visibleToUser !== false) recordAndroidAlertIdentifier(summary, node.resourceId);
  recordAndroidHelperWindowNode(summary, node);
  recordAndroidHelperMeaningfulNode(summary, node);
}

function recordAndroidAlertIdentifier(
  summary: AndroidHelperXmlSummaryState,
  resourceId: string | null,
): void {
  const kind = classifyAndroidAlertIdentifier(resourceId);
  if (kind === 'button') summary.hasAlertButtonIdentifier = true;
  if (kind === 'content') summary.hasAlertContentIdentifier = true;
}

function recordAndroidHelperWindowNode(
  summary: AndroidHelperXmlSummaryState,
  node: AndroidUiNodeMetadata,
): void {
  if (node.windowType === undefined) return;

  summary.currentWindowType = node.windowType;
  summary.currentWindowActiveOrFocused = node.windowActive === true || node.windowFocused === true;
  summary.windowRootCount += 1;
  summary.windowTypes.add(node.windowType);
  if (node.windowType === ANDROID_WINDOW_TYPE_APPLICATION) {
    summary.applicationWindowRootCount += 1;
  }
}

function recordAndroidHelperMeaningfulNode(
  summary: AndroidHelperXmlSummaryState,
  node: AndroidUiNodeMetadata,
): void {
  if (!isMeaningfulContentNode(node)) return;

  summary.meaningfulNodeCount += 1;
  recordMeaningfulWindowOwnership(summary, node);
  recordMeaningfulPackageOwnership(summary, node);
}

function recordMeaningfulWindowOwnership(
  summary: AndroidHelperXmlSummaryState,
  node: AndroidUiNodeMetadata,
): void {
  if (
    summary.currentWindowType === ANDROID_WINDOW_TYPE_APPLICATION &&
    !isAndroidSystemPackage(node.packageName)
  ) {
    summary.applicationMeaningfulNodeCount += 1;
  }
  // Status/nav-bar chrome must not satisfy the system-surface floor: an active navigation bar
  // (Back + Home + Recents) or status chrome (clock, battery, signal icons) is missing-app-content
  // residue, not a usable shade/quick-settings surface. Only non-chrome nodes count.
  if (isInActiveSystemSurfaceWindow(summary) && !isAndroidSystemChromeResourceId(node.resourceId)) {
    summary.activeSystemSurfaceMeaningfulNodeCount += 1;
  }
}

function isInActiveSystemSurfaceWindow(summary: AndroidHelperXmlSummaryState): boolean {
  return (
    summary.currentWindowType !== undefined &&
    summary.currentWindowType !== ANDROID_WINDOW_TYPE_APPLICATION &&
    summary.currentWindowActiveOrFocused === true
  );
}

function recordMeaningfulPackageOwnership(
  summary: AndroidHelperXmlSummaryState,
  node: AndroidUiNodeMetadata,
): void {
  if (!isAndroidSystemPackage(node.packageName)) {
    summary.nonSystemMeaningfulNodeCount += 1;
  }
  if (
    isAndroidInputMethodOwnedNode({
      packageName: node.packageName,
      resourceId: node.resourceId,
    })
  ) {
    summary.inputMethodMeaningfulNodeCount += 1;
  }
  if (
    summary.foregroundAppPackage !== undefined &&
    node.packageName === summary.foregroundAppPackage
  ) {
    summary.foregroundAppMeaningfulNodeCount = (summary.foregroundAppMeaningfulNodeCount ?? 0) + 1;
  }
}

function finalizeAndroidHelperXmlSummary(
  summary: AndroidHelperXmlSummaryState,
): AndroidHelperXmlSummary {
  return {
    nodeCount: summary.nodeCount,
    systemUiNodeCount: summary.systemUiNodeCount,
    windowRootCount: summary.windowRootCount,
    applicationWindowRootCount: summary.applicationWindowRootCount,
    activeSystemSurfaceMeaningfulNodeCount: summary.activeSystemSurfaceMeaningfulNodeCount,
    meaningfulNodeCount: summary.meaningfulNodeCount,
    applicationMeaningfulNodeCount: summary.applicationMeaningfulNodeCount,
    nonSystemMeaningfulNodeCount: summary.nonSystemMeaningfulNodeCount,
    inputMethodMeaningfulNodeCount: summary.inputMethodMeaningfulNodeCount,
    hasAlertButtonIdentifier: summary.hasAlertButtonIdentifier,
    hasAlertContentIdentifier: summary.hasAlertContentIdentifier,
    ...(summary.foregroundAppPackage !== undefined
      ? {
          foregroundAppPackage: summary.foregroundAppPackage,
          foregroundAppMeaningfulNodeCount: summary.foregroundAppMeaningfulNodeCount ?? 0,
        }
      : {}),
    windowTypes: [...summary.windowTypes].sort((a, b) => a - b).slice(0, MAX_REPORTED_WINDOW_TYPES),
  };
}

function isMeaningfulContentNode(node: AndroidUiNodeMetadata): boolean {
  if (node.visibleToUser === false) return false;
  return hasText(node.text) || hasText(node.desc) || hasText(node.resourceId);
}

function hasText(value: string | null): boolean {
  return value !== null && value.trim() !== '';
}

function isAndroidSystemPackage(packageName: string | null): boolean {
  return packageName === null || ANDROID_SYSTEM_PACKAGES.has(packageName);
}

function isExplicitAndroidSystemPackage(packageName: string | null): boolean {
  return packageName !== null && ANDROID_SYSTEM_PACKAGES.has(packageName);
}

function buildRecoveryDiagnostics(
  summary: AndroidHelperXmlSummary,
  metadata: AndroidSnapshotBackendMetadata,
): AndroidHelperContentRecoveryDecision['diagnostics'] {
  return {
    helperNodeCount: summary.nodeCount,
    helperSystemUiNodeCount: summary.systemUiNodeCount,
    helperWindowRootCount: summary.windowRootCount,
    helperApplicationWindowRootCount: summary.applicationWindowRootCount,
    helperMeaningfulNodeCount: summary.meaningfulNodeCount,
    helperApplicationMeaningfulNodeCount: summary.applicationMeaningfulNodeCount,
    helperNonSystemMeaningfulNodeCount: summary.nonSystemMeaningfulNodeCount,
    helperInputMethodMeaningfulNodeCount: summary.inputMethodMeaningfulNodeCount,
    ...(summary.foregroundAppPackage !== undefined
      ? {
          helperForegroundAppPackage: summary.foregroundAppPackage,
          helperForegroundAppMeaningfulNodeCount: summary.foregroundAppMeaningfulNodeCount,
          helperForegroundAppMeaningfulNodeThreshold: MIN_FOREGROUND_APP_MEANINGFUL_NODES,
        }
      : {}),
    helperWindowTypes: summary.windowTypes,
    ...(metadata.captureMode ? { helperCaptureMode: metadata.captureMode } : {}),
  };
}
