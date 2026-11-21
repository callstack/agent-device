import {
  centerOfRect,
  type Point,
  type Rect,
  type SnapshotNode,
} from '@agent-device/kernel/snapshot';
import { rectArea } from '@agent-device/kernel/rect';
import {
  isReactNativeCollapsedWarningBanner,
  isReactNativeCollapsedWarningCountBadgeBanner,
  isReactNativeCollapsedWarningEvidenceLabel,
  isReactNativeCollapsedWarningLabel,
  isReactNativeOverlayDismissLabel,
  isReactNativeOverlayMinimizeLabel,
} from '@agent-device/contracts/react-native-overlay';
import type {
  ReactNativeOverlayNode,
  ReactNativeOverlaySurface,
} from '@agent-device/contracts/react-native-overlay';

export type ReactNativeOverlayState = {
  detected: boolean;
  dismissNodes: SnapshotNode[];
  minimizeNodes: SnapshotNode[];
  collapsedNodes: SnapshotNode[];
  primaryAction: ReactNativeOverlayDismissTarget | null;
};

export type ReactNativeOverlayDismissTarget = {
  action: 'close' | 'dismiss' | 'close-collapsed-banner';
  point: Point;
  rect?: Rect;
  ref?: string;
  label?: string;
  warning?: string;
};

type ReactNativeOverlayFacts = {
  dismissNodes: SnapshotNode[];
  minimizeNodes: SnapshotNode[];
  collapsedNodes: SnapshotNode[];
  collapsedCountBadgeNodes: SnapshotNode[];
  detected: boolean;
};

const KNOWN_OVERLAY_TEXT_PATTERN =
  /\b(logbox|redbox|reload js|copy stack|component stack|call stack|runtime error|open debugger to view warnings)\b/;
const REACT_NATIVE_STACK_FRAME_PATTERNS = [
  /\b[\w.$<>/-]+\.(?:tsx?|jsx?):\d+(?::\d+)?\b/,
  /\b[\w.$<>/-]+\.(?:tsx?|jsx?)\s+\(\d+:\d+\)/,
] as const;
const CLOSE_ICON_LABELS = new Set(['x', '×', '✕', '✖', '⨯']);

export function formatReactNativeOverlayWarning(
  nodes: SnapshotNode[],
  surface?: ReactNativeOverlaySurface,
): string | undefined {
  const overlay = analyzeReactNativeOverlay(nodes, surface);
  if (!overlay.detected) return undefined;
  return [
    'Hint: React Native warning/error overlay detected. It overlays part of the app and should be handled before interacting.',
    'Run: agent-device react-native dismiss-overlay',
    'The command verifies the overlay is gone. Run agent-device snapshot -i afterward only when you need fresh refs for the next action.',
  ].join('\n');
}

export function analyzeReactNativeOverlay(
  nodes: SnapshotNode[],
  surface?: ReactNativeOverlaySurface,
): ReactNativeOverlayState {
  const facts = collectReactNativeOverlayFacts(nodes, surface);
  const primaryAction = facts.detected ? resolveSafeDismissAction(facts) : null;

  return {
    detected: facts.detected,
    dismissNodes: facts.dismissNodes,
    minimizeNodes: facts.minimizeNodes,
    collapsedNodes: facts.collapsedNodes,
    primaryAction,
  };
}

function collectReactNativeOverlayFacts(
  nodes: SnapshotNode[],
  surface: ReactNativeOverlaySurface | undefined,
): ReactNativeOverlayFacts {
  const text = nodes.map(formatNodeSearchText).join('\n').toLowerCase();
  const dismissNodes = collectOverlayNodes(nodes, isDismissControlLabel);
  const minimizeNodes = collectOverlayNodes(nodes, isReactNativeOverlayMinimizeLabel);
  const collapsedNodes = nodes.filter((node) => node.ref && isCollapsedWarningNode(node, surface));
  const openDebuggerWarningNodes = collectOverlayNodes(
    nodes,
    isReactNativeOpenDebuggerWarningLabel,
  );
  const hasReactNativeStackFrame = isReactNativeStackFrame(text);
  const hasControllessRedBoxText = hasUnableToDownloadAssetRedBox(text);
  const hasOverlayControl = hasReactNativeOverlayControlText(text, dismissNodes, minimizeNodes);
  const collapsedCountBadgeNodes = collapsedNodes.filter((node) =>
    isReactNativeCollapsedWarningCountBadgeBanner(node, surface),
  );
  return {
    dismissNodes,
    minimizeNodes,
    collapsedNodes,
    collapsedCountBadgeNodes,
    detected: isReactNativeOverlayDetected({
      text,
      hasReactNativeStackFrame,
      hasOverlayControl,
      hasControllessRedBoxText,
      collapsedNodes,
      collapsedEvidenceNodes: collapsedNodes.filter((node) =>
        nodeHasMatchingLabel(node, isReactNativeCollapsedWarningEvidenceLabel),
      ),
      collapsedCountBadgeNodes,
      openDebuggerWarningNodes,
    }),
  };
}

/**
 * A banner candidate: either its label names a collapsed warning and its shape allows one, or it
 * carries LogBox's entry-count badge in a LogBox banner's place. A count label alone reads like an
 * ordinary row, so only the placement — measured in the capture's own box — says banner.
 */
function isCollapsedWarningNode(
  node: SnapshotNode,
  surface: ReactNativeOverlaySurface | undefined,
): boolean {
  if (isReactNativeCollapsedWarningCountBadgeBanner(node, surface)) return true;
  return (
    isLikelyCollapsedWarningControl(node) &&
    nodeHasMatchingLabel(node, isReactNativeCollapsedWarningLabel)
  );
}

function resolveSafeDismissAction(
  facts: ReactNativeOverlayFacts,
): ReactNativeOverlayDismissTarget | null {
  const dismiss = firstControlNodeWithRect(facts.dismissNodes);
  if (dismiss) return targetFromNode(dismiss, actionFromDismissNode(dismiss));

  const collapsed = chooseCollapsedWarningNode(
    facts.collapsedNodes.filter((node) => isSafeCollapsedWarningCoordinateFallback(node, facts)),
  );
  if (!collapsed?.rect) return null;
  return {
    action: 'close-collapsed-banner',
    point: collapsedBannerClosePoint(collapsed),
    rect: collapsed.rect,
    ref: collapsed.ref,
    label: readNodeLabel(collapsed),
  };
}

function formatNodeSearchText(node: SnapshotNode): string {
  return [node.label, node.value, node.identifier, node.type, node.role].filter(Boolean).join(' ');
}

function hasKnownReactNativeOverlayText(text: string): boolean {
  return KNOWN_OVERLAY_TEXT_PATTERN.test(text);
}

function isReactNativeStackFrame(text: string): boolean {
  return REACT_NATIVE_STACK_FRAME_PATTERNS.some((pattern) => pattern.test(text));
}

function hasUnableToDownloadAssetRedBox(text: string): boolean {
  return /\buncaught\b/.test(text) && /unable to download asset/.test(text);
}

function hasReactNativeOverlayControlText(
  text: string,
  dismissNodes: SnapshotNode[],
  minimizeNodes: SnapshotNode[],
): boolean {
  return (
    dismissNodes.length > 0 || minimizeNodes.length > 0 || /\b(reload js|copy stack)\b/.test(text)
  );
}

function isReactNativeOverlayDetected(params: {
  text: string;
  hasReactNativeStackFrame: boolean;
  hasOverlayControl: boolean;
  hasControllessRedBoxText: boolean;
  collapsedNodes: SnapshotNode[];
  collapsedEvidenceNodes: SnapshotNode[];
  collapsedCountBadgeNodes: SnapshotNode[];
  openDebuggerWarningNodes: SnapshotNode[];
}): boolean {
  const hasOverlayContext =
    params.hasReactNativeStackFrame || hasKnownReactNativeOverlayText(params.text);
  return (
    params.collapsedEvidenceNodes.length > 0 ||
    params.collapsedCountBadgeNodes.length > 0 ||
    (params.collapsedNodes.length > 0 && hasOverlayContext) ||
    params.openDebuggerWarningNodes.length > 0 ||
    params.hasControllessRedBoxText ||
    (params.hasOverlayControl &&
      (hasKnownReactNativeOverlayText(params.text) || params.hasReactNativeStackFrame))
  );
}

function isReactNativeOpenDebuggerWarningLabel(label: string): boolean {
  return label.includes('open debugger to view warnings') || /^!,\s+open debugger\b/.test(label);
}

function isDismissControlLabel(label: string): boolean {
  return isReactNativeOverlayDismissLabel(label) || isCloseLabel(label) || isCloseIconLabel(label);
}

function isCloseLabel(label: string): boolean {
  return /^close(?:\s*\([^)]*\))?$/i.test(label);
}

function isCloseIconLabel(label: string): boolean {
  return CLOSE_ICON_LABELS.has(label);
}

function isCollapsedWarningSummaryLabel(label: string): boolean {
  return /^!,\s+/.test(label);
}

function isLikelyCollapsedWarningControl(node: SnapshotNode): boolean {
  return !node.rect || node.rect.height <= 180;
}

function isSafeCollapsedWarningCoordinateFallback(
  node: SnapshotNode,
  facts: ReactNativeOverlayFacts,
): boolean {
  if (facts.collapsedCountBadgeNodes.includes(node)) return true;
  if (!isReactNativeCollapsedWarningBanner(node)) return false;
  const label = readNodeLabel(node)?.trim().toLowerCase() ?? '';
  return isReactNativeOpenDebuggerWarningLabel(label) || isCollapsedWarningSummaryLabel(label);
}

/** Reads every text a node carries, lowercased, against a label classifier. */
function nodeHasMatchingLabel(
  node: ReactNativeOverlayNode,
  matches: (label: string) => boolean,
): boolean {
  return [node.label, node.value, node.identifier]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value))
    .some((value) => matches(value));
}

function collectOverlayNodes(
  nodes: SnapshotNode[],
  matches: (label: string) => boolean,
): SnapshotNode[] {
  return nodes.filter((node) => node.ref && nodeHasMatchingLabel(node, matches));
}

function firstControlNodeWithRect(nodes: SnapshotNode[]): SnapshotNode | null {
  return selectHighestScoredNode(nodes, controlNodeScores);
}

function isSemanticControlNode(node: ReactNativeOverlayNode): boolean {
  const roleText = [node.type, node.role, node.subrole].join(' ').toLowerCase();
  return /\b(button|menuitem|link)\b/.test(roleText);
}

function controlNodeScores(node: SnapshotNode): number[] {
  return [
    booleanScore(isSemanticControlNode(node)),
    booleanScore(node.hittable),
    -(node.rect ? rectArea(node.rect) : Number.POSITIVE_INFINITY),
  ];
}

function targetFromNode(
  node: SnapshotNode,
  action: ReactNativeOverlayDismissTarget['action'],
): ReactNativeOverlayDismissTarget {
  if (!node.rect) {
    throw new Error('React Native overlay target node must have rect');
  }
  return {
    action,
    point: centerOfRect(node.rect),
    rect: node.rect,
    ref: node.ref,
    label: readNodeLabel(node),
  };
}

function actionFromDismissNode(node: SnapshotNode): ReactNativeOverlayDismissTarget['action'] {
  const label = readNodeLabel(node)?.trim().toLowerCase();
  if (label && isReactNativeOverlayDismissLabel(label)) return 'dismiss';
  return 'close';
}

function chooseCollapsedWarningNode(nodes: SnapshotNode[]): SnapshotNode | null {
  return selectHighestScoredNode(nodes, collapsedWarningScores);
}

function selectHighestScoredNode(
  nodes: SnapshotNode[],
  scoreNode: (node: SnapshotNode) => number[],
): SnapshotNode | null {
  const withRect = nodes.filter((node) => node.rect);
  if (withRect.length === 0) return null;
  return withRect.sort((a, b) => compareScoreVectors(scoreNode(b), scoreNode(a)))[0] ?? null;
}

function collapsedWarningScores(node: SnapshotNode): number[] {
  return [booleanScore(node.hittable), node.rect?.width ?? 0, node.rect?.y ?? 0];
}

function booleanScore(value: unknown): number {
  return value === true ? 1 : 0;
}

function compareScoreVectors(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function collapsedBannerClosePoint(node: SnapshotNode): Point {
  if (!node.rect) throw new Error('Collapsed React Native warning node must have rect');
  const closeTargetHeight = Math.min(node.rect.height, 52);
  const inset = Math.min(36, Math.max(18, closeTargetHeight * 0.45));
  return {
    x: Math.round(
      clamp(
        node.rect.x + node.rect.width - inset,
        node.rect.x + 1,
        node.rect.x + node.rect.width - 1,
      ),
    ),
    y: Math.round(node.rect.y + closeTargetHeight / 2),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readNodeLabel(node: ReactNativeOverlayNode): string | undefined {
  return node.label ?? node.value ?? node.identifier;
}
