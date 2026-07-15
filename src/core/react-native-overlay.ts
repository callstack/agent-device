import {
  centerOfRect,
  type Point,
  type RawSnapshotNode,
  type Rect,
  type SnapshotNode,
} from '../kernel/snapshot.ts';
import { rectArea } from '../kernel/rect.ts';

type ReactNativeOverlayNode = Pick<
  RawSnapshotNode,
  'index' | 'type' | 'role' | 'subrole' | 'label' | 'value' | 'identifier' | 'rect' | 'hittable'
>;

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
  detected: boolean;
};

const KNOWN_OVERLAY_TEXT_PATTERN =
  /\b(logbox|redbox|reload js|copy stack|component stack|call stack|runtime error|open debugger to view warnings)\b/;
const REACT_NATIVE_STACK_FRAME_PATTERNS = [
  /\b[\w.$<>/-]+\.(?:tsx?|jsx?):\d+(?::\d+)?\b/,
  /\b[\w.$<>/-]+\.(?:tsx?|jsx?)\s+\(\d+:\d+\)/,
] as const;
const COLLAPSED_WARNING_PREFIX_PATTERNS = [
  /^!,\s+/,
  /^(warn|warning|error):\s+/,
  /\b(?:possible\s+)?unhandled (?:promise )?rejection\b/,
] as const;
const COLLAPSED_WARNING_TEXT_MARKERS = [
  'open debugger to view warnings',
  'getsnapshot should be cached to avoid an infinite loop',
  'unique "key" prop',
  "unique 'key' prop",
  'virtualizedlists should never be nested',
  'failed prop type',
] as const;
const CLOSE_ICON_LABELS = new Set(['x', '×', '✕', '✖', '⨯']);

export function formatReactNativeOverlayWarning(nodes: SnapshotNode[]): string | undefined {
  const overlay = analyzeReactNativeOverlay(nodes);
  if (!overlay.detected) return undefined;
  return [
    'Hint: React Native warning/error overlay detected. It overlays part of the app and should be handled before interacting.',
    'Run: agent-device react-native dismiss-overlay',
    'The command verifies the overlay is gone. Run agent-device snapshot -i afterward only when you need fresh refs for the next action.',
  ].join('\n');
}

export function analyzeReactNativeOverlay(nodes: SnapshotNode[]): ReactNativeOverlayState {
  const facts = collectReactNativeOverlayFacts(nodes);
  const primaryAction = facts.detected ? resolveSafeDismissAction(facts) : null;

  return {
    detected: facts.detected,
    dismissNodes: facts.dismissNodes,
    minimizeNodes: facts.minimizeNodes,
    collapsedNodes: facts.collapsedNodes,
    primaryAction,
  };
}

export function isReactNativeCollapsedWarningWrapperCandidate(
  node: ReactNativeOverlayNode,
): boolean {
  return (
    isReactNativeCollapsedWarningLabel(node.label?.trim()) && isFullScreenOverlayRect(node.rect)
  );
}

export function isReactNativeCollapsedWarningWrapperWithVisibleBanner(
  node: ReactNativeOverlayNode,
  descendants: ReactNativeOverlayNode[],
): boolean {
  const nodeLabel = node.label?.trim();
  if (!nodeLabel || !isReactNativeCollapsedWarningWrapperCandidate(node)) return false;
  return descendants.some(
    (descendant) =>
      descendant.label?.trim() === nodeLabel && isReactNativeCollapsedWarningBanner(descendant),
  );
}

function collectReactNativeOverlayFacts(nodes: SnapshotNode[]): ReactNativeOverlayFacts {
  const text = nodes.map(formatNodeSearchText).join('\n').toLowerCase();
  const dismissNodes = collectOverlayNodes(nodes, isDismissControlLabel);
  const minimizeNodes = collectOverlayNodes(nodes, isReactNativeOverlayMinimizeLabel);
  const collapsedNodes = collectOverlayNodes(
    nodes,
    isReactNativeCollapsedWarningLabel,
    isLikelyCollapsedWarningControl,
  );
  const openDebuggerWarningNodes = collectOverlayNodes(
    nodes,
    isReactNativeOpenDebuggerWarningLabel,
  );
  const hasReactNativeStackFrame = isReactNativeStackFrame(text);
  const hasControllessRedBoxText = hasUnableToDownloadAssetRedBox(text);
  const hasOverlayControl = hasReactNativeOverlayControlText(text, dismissNodes, minimizeNodes);
  return {
    dismissNodes,
    minimizeNodes,
    collapsedNodes,
    detected: isReactNativeOverlayDetected({
      text,
      hasReactNativeStackFrame,
      hasOverlayControl,
      hasControllessRedBoxText,
      collapsedNodes,
      openDebuggerWarningNodes,
    }),
  };
}

function resolveSafeDismissAction(
  facts: ReactNativeOverlayFacts,
): ReactNativeOverlayDismissTarget | null {
  const dismiss = firstControlNodeWithRect(facts.dismissNodes);
  if (dismiss) return targetFromNode(dismiss, actionFromDismissNode(dismiss));

  const collapsed = chooseCollapsedWarningNode(
    facts.collapsedNodes.filter(isSafeCollapsedWarningCoordinateFallback),
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
  openDebuggerWarningNodes: SnapshotNode[];
}): boolean {
  return (
    params.collapsedNodes.length > 0 ||
    params.openDebuggerWarningNodes.length > 0 ||
    params.hasControllessRedBoxText ||
    (params.hasOverlayControl &&
      (hasKnownReactNativeOverlayText(params.text) || params.hasReactNativeStackFrame))
  );
}

function isReactNativeCollapsedWarningLabel(rawLabel: string | undefined): boolean {
  const label = rawLabel?.trim().toLowerCase();
  if (!label) return false;
  return (
    COLLAPSED_WARNING_TEXT_MARKERS.some((marker) => label.includes(marker)) ||
    COLLAPSED_WARNING_PREFIX_PATTERNS.some((pattern) => pattern.test(label))
  );
}

function isReactNativeOpenDebuggerWarningLabel(label: string): boolean {
  return label.includes('open debugger to view warnings') || /^!,\s+open debugger\b/.test(label);
}

function isDismissControlLabel(label: string): boolean {
  return isReactNativeOverlayDismissLabel(label) || isCloseLabel(label) || isCloseIconLabel(label);
}

export function isReactNativeOverlayDismissLabel(label: string): boolean {
  return /^dismiss(?:\s*\([^)]*\))?$/i.test(label);
}

function isCloseLabel(label: string): boolean {
  return /^close(?:\s*\([^)]*\))?$/i.test(label);
}

function isCloseIconLabel(label: string): boolean {
  return CLOSE_ICON_LABELS.has(label);
}

export function isReactNativeOverlayMinimizeLabel(label: string): boolean {
  return /^minimi[sz]e(?:\b|\s|\()/i.test(label);
}

function isCollapsedWarningSummaryLabel(label: string): boolean {
  return /^!,\s+/.test(label);
}

function isLikelyCollapsedWarningControl(node: SnapshotNode): boolean {
  return !node.rect || node.rect.height <= 180;
}

function isSafeCollapsedWarningCoordinateFallback(node: SnapshotNode): boolean {
  const label = readNodeLabel(node)?.trim().toLowerCase() ?? '';
  return (
    (isReactNativeOpenDebuggerWarningLabel(label) || isCollapsedWarningSummaryLabel(label)) &&
    isReactNativeCollapsedWarningBanner(node)
  );
}

function isFullScreenOverlayRect(rect: RawSnapshotNode['rect']): boolean {
  if (!rect) return false;
  return rect.x <= 1 && rect.y <= 1 && rect.width >= 300 && rect.height >= 600;
}

function isReactNativeCollapsedWarningBanner(node: ReactNativeOverlayNode): boolean {
  if (!node.rect) return false;
  return node.rect.width >= 120 && node.rect.height >= 36 && node.rect.height <= 180;
}

function collectOverlayNodes(
  nodes: SnapshotNode[],
  matches: (label: string) => boolean,
  includeNode: (node: SnapshotNode) => boolean = () => true,
): SnapshotNode[] {
  const matchedNodes: SnapshotNode[] = [];
  for (const node of nodes) {
    if (!node.ref) continue;
    if (!includeNode(node)) continue;
    const labels = [node.label, node.value, node.identifier]
      .map((value) => value?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value));
    if (!labels.some((label) => matches(label))) continue;
    matchedNodes.push(node);
  }
  return matchedNodes;
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
