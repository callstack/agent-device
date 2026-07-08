import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';
import { isAndroidInputMethodOwnedNode } from '../../core/android-input-ownership.ts';
import { androidUiNodes, type AndroidUiNodeMetadata } from './ui-hierarchy.ts';

const ANDROID_WINDOW_TYPE_APPLICATION = 1;
const MAX_REPORTED_WINDOW_TYPES = 8;
const MIN_FOREGROUND_APP_MEANINGFUL_NODES = 2;
const MIN_INPUT_METHOD_MEANINGFUL_NODES = 2;
const ANDROID_SYSTEM_PACKAGES = new Set(['android', 'com.android.systemui']);
const INSUFFICIENT_APP_CONTENT_REASON =
  'Android snapshot helper returned insufficient application window content';

export type AndroidHelperContentRecoveryDecision = {
  reason: 'empty-helper-output' | 'system-window-only' | 'content-poor-app-window';
  fallbackReason: string;
  diagnostics: {
    helperNodeCount: number;
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

export function classifyAndroidHelperContentRecovery(
  xml: string,
  metadata: AndroidSnapshotBackendMetadata,
  options: { foregroundAppPackage?: string } = {},
): AndroidHelperContentRecoveryDecision | undefined {
  if (metadata.backend !== 'android-helper') return undefined;

  const summary = summarizeAndroidHelperXml(xml, options.foregroundAppPackage);
  if (isEmptyHelperOutput(summary, metadata)) {
    return buildRecoveryDecision(
      summary,
      metadata,
      'empty-helper-output',
      'Android snapshot helper returned no accessibility nodes',
    );
  }

  if (isForegroundAppContentHiddenByInputMethod(summary)) return undefined;
  if (isForegroundAppContentPoor(summary)) {
    return buildRecoveryDecision(
      summary,
      metadata,
      'content-poor-app-window',
      'Android snapshot helper returned insufficient foreground app content',
    );
  }

  if (isApplicationWindowContentPoor(summary)) {
    return buildRecoveryDecision(
      summary,
      metadata,
      'content-poor-app-window',
      INSUFFICIENT_APP_CONTENT_REASON,
    );
  }

  if (isWindowlessMultiWindowContentPoor(summary, metadata)) {
    return buildRecoveryDecision(
      summary,
      metadata,
      'content-poor-app-window',
      INSUFFICIENT_APP_CONTENT_REASON,
    );
  }

  if (isSystemWindowOnly(summary)) {
    return buildRecoveryDecision(
      summary,
      metadata,
      'system-window-only',
      'Android snapshot helper returned only non-application windows',
    );
  }

  return undefined;
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
  if (foregroundCount === 0) return true;
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
  return summary.windowRootCount > 0 && summary.applicationWindowRootCount === 0;
}

function buildRecoveryDecision(
  summary: AndroidHelperXmlSummary,
  metadata: AndroidSnapshotBackendMetadata,
  reason: AndroidHelperContentRecoveryDecision['reason'],
  fallbackReason: string,
): AndroidHelperContentRecoveryDecision {
  return {
    reason,
    fallbackReason,
    diagnostics: buildRecoveryDiagnostics(summary, metadata),
  };
}

type AndroidHelperXmlSummary = {
  nodeCount: number;
  windowRootCount: number;
  applicationWindowRootCount: number;
  meaningfulNodeCount: number;
  applicationMeaningfulNodeCount: number;
  nonSystemMeaningfulNodeCount: number;
  inputMethodMeaningfulNodeCount: number;
  foregroundAppPackage?: string;
  foregroundAppMeaningfulNodeCount?: number;
  windowTypes: number[];
};

type AndroidHelperXmlSummaryState = Omit<AndroidHelperXmlSummary, 'windowTypes'> & {
  currentWindowType?: number;
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
    windowRootCount: 0,
    applicationWindowRootCount: 0,
    meaningfulNodeCount: 0,
    applicationMeaningfulNodeCount: 0,
    nonSystemMeaningfulNodeCount: 0,
    inputMethodMeaningfulNodeCount: 0,
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
  recordAndroidHelperWindowNode(summary, node);
  recordAndroidHelperMeaningfulNode(summary, node);
}

function recordAndroidHelperWindowNode(
  summary: AndroidHelperXmlSummaryState,
  node: AndroidUiNodeMetadata,
): void {
  if (node.windowType === undefined) return;

  summary.currentWindowType = node.windowType;
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
  if (summary.currentWindowType === ANDROID_WINDOW_TYPE_APPLICATION) {
    summary.applicationMeaningfulNodeCount += 1;
  }
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
    windowRootCount: summary.windowRootCount,
    applicationWindowRootCount: summary.applicationWindowRootCount,
    meaningfulNodeCount: summary.meaningfulNodeCount,
    applicationMeaningfulNodeCount: summary.applicationMeaningfulNodeCount,
    nonSystemMeaningfulNodeCount: summary.nonSystemMeaningfulNodeCount,
    inputMethodMeaningfulNodeCount: summary.inputMethodMeaningfulNodeCount,
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

function buildRecoveryDiagnostics(
  summary: AndroidHelperXmlSummary,
  metadata: AndroidSnapshotBackendMetadata,
): AndroidHelperContentRecoveryDecision['diagnostics'] {
  return {
    helperNodeCount: summary.nodeCount,
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
