import {
  centerOfRect,
  type Point,
  type Rect,
  type SnapshotNode,
} from '@agent-device/kernel/snapshot';
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
  action: 'dismiss' | 'close-collapsed-banner';
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
  /** Minimize, Reload, Copy and Extra Info: the controls that share a footer with Dismiss. */
  footerPartnerNodes: SnapshotNode[];
  surface: ReactNativeOverlaySurface | undefined;
  detected: boolean;
};

const KNOWN_OVERLAY_TEXT_PATTERN =
  /\b(logbox|redbox|reload js|copy stack|component stack|call stack|runtime error|open debugger to view warnings)\b/;
const REACT_NATIVE_STACK_FRAME_PATTERNS = [
  /\b[\w.$<>/-]+\.(?:tsx?|jsx?):\d+(?::\d+)?\b/,
  /\b[\w.$<>/-]+\.(?:tsx?|jsx?)\s+\(\d+:\d+\)/,
] as const;
const CLOSE_ICON_LABELS = new Set(['x', '×', '✕', '✖', '⨯']);
const FOOTER_PARTNER_PATTERN = /^(?:minimi[sz]e|reload(?: js)?|copy|extra info)(?:\s*\([^)]*\))?$/;
/** Text centered in its column can sit a rounding step off the column's center. */
const FOOTER_ALIGNMENT_TOLERANCE_DP = 2;
/**
 * The widest side gap a footer keeps from the surface edge in landscape. iOS wraps each footer button
 * in a SafeAreaView, and an iPhone's landscape side inset is at most 62 pt; Android's LogBoxDialog and
 * RedBoxDialogSurfaceDelegate margin the root by the system-bar and cutout insets, 48 dp for a side
 * navigation bar. An app's centered button pair sits hundreds of points in.
 */
const FOOTER_LANDSCAPE_SIDE_INSET_MAX_DP = 80;
/**
 * Without a surface the side gaps cannot be measured, so only a footer of three or more columns is
 * read: LogBox's has three and RedBox's four, while an app's two-button row would pass the spacing.
 */
const FOOTER_MIN_COLUMNS_WITHOUT_SURFACE = 3;

const EXPO_DEV_MENU_VERSION_PATTERN = /^(?:runtime|sdk) version: \S/;
const EXPO_DEV_MENU_ACTION_LABELS = new Set(['reload', 'go home']);

export function formatReactNativeOverlayWarning(
  nodes: SnapshotNode[],
  surface?: ReactNativeOverlaySurface,
): string | undefined {
  if (showsExpoDevMenuText(nodes)) {
    return [
      'Hint: The Expo dev menu looks open. It takes every tap until it closes, so press its Close button first.',
      "When you launch the app with your own expo-development-client URL, add disableAutoLaunch=1 to it, or turn off the menu's show-at-launch setting.",
    ].join('\n');
  }
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
    footerPartnerNodes: collectOverlayNodes(nodes, (label) => FOOTER_PARTNER_PATTERN.test(label)),
    surface,
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

/**
 * Apps name their own buttons Dismiss and Close, so the only control taken is the footer Dismiss of
 * LogBox's inspector or of RedBox. A collapsed banner is closed at its own affordance, except while
 * the inspector's Dismiss and Minimize are on screen: the banner then lies under the inspector.
 */
function resolveSafeDismissAction(
  facts: ReactNativeOverlayFacts,
): ReactNativeOverlayDismissTarget | null {
  const footer = findOverlayFooterDismiss(facts);
  if (footer) {
    return {
      action: 'dismiss',
      point: centerOfRect(footer.column),
      rect: footer.column,
      ref: footer.node.ref,
      label: readNodeLabel(footer.node),
    };
  }
  if (isInspectorFooterVocabularyOnScreen(facts)) return null;

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
/**
 * The Expo dev menu's header line and one of its first actions, read as text only: the menu's
 * layout differs by platform, capture and Expo release. Android's interactive capture drops the
 * header line, so only its full snapshot carries both.
 */
function showsExpoDevMenuText(nodes: readonly SnapshotNode[]): boolean {
  return (
    nodes.some((node) =>
      nodeHasMatchingLabel(node, (label) => EXPO_DEV_MENU_VERSION_PATTERN.test(label)),
    ) &&
    nodes.some((node) =>
      nodeHasMatchingLabel(node, (label) => EXPO_DEV_MENU_ACTION_LABELS.has(label)),
    )
  );
}

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

type OverlayFooterDismiss = { node: SnapshotNode; column: Rect };
type RectNode = SnapshotNode & { rect: Rect };

/**
 * LogBox's inspector footer (`flex: 1` buttons) and RedBox's footer (a fill-equally stack view on
 * iOS, weighted buttons on Android) give each control an equal column across one row, so Dismiss and
 * its partners sit centered at an even spacing. The row may stop short of the surface edges only by
 * the side inset a landscape window keeps. A capture hands over the full tile, only its text, or a
 * row it folded the Dismiss tile into, labelled Dismiss and holding the other tiles; the target is
 * Dismiss's column in each case.
 *
 * Candidates are tried from the end of the capture. The simulator accessibility capture lists the
 * LogBox and RedBox windows after the app's, so an app bar shaped like a footer loses to the real one
 * there, and a row is listed before the tiles it holds, so a tile wins over the row folded around it.
 */
function findOverlayFooterDismiss(facts: ReactNativeOverlayFacts): OverlayFooterDismiss | null {
  const tolerance = footerTolerance(facts.surface);
  const dismissNodes = facts.dismissNodes.filter(
    (node): node is RectNode =>
      node.rect !== undefined && nodeHasMatchingLabel(node, isReactNativeOverlayDismissLabel),
  );
  for (const node of [...dismissNodes].reverse()) {
    const column =
      footerDismissColumn(node.rect, false, facts, tolerance) ??
      footerDismissColumn(node.rect, true, facts, tolerance);
    if (column) return { node, column };
  }
  return null;
}

function footerDismissColumn(
  rect: Rect,
  folded: boolean,
  facts: ReactNativeOverlayFacts,
  tolerance: number,
): Rect | undefined {
  const partnerCenters = footerPartnerCenters(rect, facts.footerPartnerNodes, tolerance);
  if (!partnerCenters || partnerCenters.length === 0) return undefined;
  let dismissCenter = rect.x + rect.width / 2;
  if (folded) {
    // The Dismiss slot is the column before the partners, or after them right to left.
    if (partnerCenters.length < 2) return undefined;
    const spacing = partnerCenters[1]! - partnerCenters[0]!;
    const slot = [partnerCenters[0]! - spacing, partnerCenters.at(-1)! + spacing].find(
      (center) => center > rect.x && center < rect.x + rect.width,
    );
    if (slot === undefined) return undefined;
    dismissCenter = slot;
  }
  const centers = [...partnerCenters, dismissCenter].sort((left, right) => left - right);
  const first = centers[0]!;
  const spacing = (centers.at(-1)! - first) / (centers.length - 1);
  if (centers.some((center, column) => Math.abs(center - (first + column * spacing)) > tolerance)) {
    return undefined;
  }
  const rowStart = first - spacing / 2;
  const rowEnd = centers.at(-1)! + spacing / 2;
  if (!hasFooterSideGaps(rowStart, rowEnd, centers.length, facts.surface, tolerance)) {
    return undefined;
  }
  return { x: dismissCenter - spacing / 2, y: rect.y, width: spacing, height: rect.height };
}

/**
 * One center per partner name in the row, sorted. A capture can list a control twice, as its tile
 * and as its text, so a name counts once; a name at two positions is not a footer.
 */
function footerPartnerCenters(
  rect: Rect,
  partners: SnapshotNode[],
  tolerance: number,
): number[] | undefined {
  const centersByName = new Map<string, number>();
  for (const partner of partners) {
    if (!partner.rect || !isSameRow(partner.rect, rect, tolerance)) continue;
    const name = readNodeLabel(partner)?.trim().toLowerCase().split(/[\s(]/)[0] ?? '';
    const center = partner.rect.x + partner.rect.width / 2;
    const known = centersByName.get(name);
    if (known !== undefined && Math.abs(known - center) > tolerance) return undefined;
    centersByName.set(name, center);
  }
  return [...centersByName.values()].sort((left, right) => left - right);
}

function hasFooterSideGaps(
  rowStart: number,
  rowEnd: number,
  columns: number,
  surface: ReactNativeOverlaySurface | undefined,
  tolerance: number,
): boolean {
  if (!surface) return columns >= FOOTER_MIN_COLUMNS_WITHOUT_SURFACE;
  // Portrait has no side safe-area inset, so the row meets both edges.
  const maxGap =
    surface.width > surface.height
      ? FOOTER_LANDSCAPE_SIDE_INSET_MAX_DP * (surface.rectUnitsPerDp ?? 1)
      : tolerance;
  return [rowStart, surface.width - rowEnd].every((gap) => gap >= -tolerance && gap <= maxGap);
}

function footerTolerance(surface: ReactNativeOverlaySurface | undefined): number {
  return FOOTER_ALIGNMENT_TOLERANCE_DP * (surface?.rectUnitsPerDp ?? 1);
}

function isSameRow(rect: Rect, other: Rect, tolerance: number): boolean {
  return Math.abs(rect.y + rect.height / 2 - (other.y + other.height / 2)) <= tolerance;
}

/** The inspector's Dismiss and Minimize share its footer row; the banner it opened from stays below. */
function isInspectorFooterVocabularyOnScreen(facts: ReactNativeOverlayFacts): boolean {
  const tolerance = footerTolerance(facts.surface);
  return facts.dismissNodes.some(
    (dismiss) =>
      dismiss.rect !== undefined &&
      nodeHasMatchingLabel(dismiss, isReactNativeOverlayDismissLabel) &&
      facts.minimizeNodes.some(
        (minimize) =>
          minimize.rect !== undefined && isSameRow(minimize.rect, dismiss.rect!, tolerance),
      ),
  );
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
