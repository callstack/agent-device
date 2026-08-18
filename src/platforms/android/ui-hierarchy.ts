import type { RawSnapshotNode, Rect, SnapshotOptions } from '@agent-device/kernel/snapshot';
import { parseBounds } from '@agent-device/kernel/bounds';
import { decodeXmlCharacterReferences } from '@agent-device/xml';
import { isScrollableType } from '@agent-device/contracts/snapshot';
import { scopePresentedAndroidSnapshot } from './ui-hierarchy-scope.ts';
import {
  type AndroidSystemChromeProvenance,
  isAndroidSystemChromeWindowResourceId,
} from '@agent-device/contracts/platform';

type AndroidRawSnapshotNode = RawSnapshotNode & AndroidSystemChromeProvenance;

export type AndroidSnapshotAnalysis = {
  rawNodeCount: number;
  maxDepth: number;
};

/** Parsed node metadata plus status/navigation subtree provenance when present. */
export type AndroidUiNodeMetadata = {
  text: string | null;
  desc: string | null;
  resourceId: string | null;
  packageName: string | null;
  className: string | null;
  bounds: string | null;
  rect?: Rect;
  clickable?: boolean;
  enabled?: boolean;
  visibleToUser?: boolean;
  drawingOrder?: number;
  focusable?: boolean;
  focused?: boolean;
  password?: boolean;
  scrollable?: boolean;
  canScrollForward?: boolean;
  canScrollBackward?: boolean;
  windowIndex?: number;
  windowType?: number;
  windowLayer?: number;
  windowActive?: boolean;
  windowFocused?: boolean;
  windowRect?: Rect;
} & AndroidSystemChromeProvenance;

/**
 * Membership of the status-bar/nav-bar subtree over a `<node>` token stream: the
 * container id is the only chrome signal in the tree, its clock/battery/wifi
 * leaves carrying no marker of their own.
 */
function createAndroidChromeSubtreeTracker() {
  const openElements: boolean[] = [];
  const inChromeNow = (): boolean => openElements[openElements.length - 1] === true;
  return {
    /** Enters an opening tag; returns whether that node is inside the chrome subtree. */
    open(resourceId: string | null | undefined, selfClosing: boolean): boolean {
      const inChrome = inChromeNow() || isAndroidSystemChromeWindowResourceId(resourceId);
      if (!selfClosing) openElements.push(inChrome);
      return inChrome;
    },
    /** Handles `</node>`. */
    close(): void {
      openElements.pop();
    },
  };
}

/** Streams `<node>` metadata in document order, carrying status-bar/nav-bar provenance. */
export function* androidUiNodes(xml: string): IterableIterator<AndroidUiNodeMetadata> {
  const tokenRegex = /<node\b[^>]*>|<\/node>/g;
  const chrome = createAndroidChromeSubtreeTracker();
  let match = tokenRegex.exec(xml);
  while (match) {
    const token = match[0];
    if (token.startsWith('</node')) {
      chrome.close();
    } else {
      const metadata = readAndroidUiNodeMetadata(token);
      const inChrome = chrome.open(metadata.resourceId, token.endsWith('/>'));
      yield inChrome ? { ...metadata, systemChrome: true } : metadata;
    }
    match = tokenRegex.exec(xml);
  }
}

function readAndroidUiNodeMetadata(node: string): AndroidUiNodeMetadata {
  const attrs = readNodeAttributes(node);
  const rect = parseBounds(attrs.bounds);
  return {
    ...attrs,
    ...(rect ? { rect } : {}),
  };
}

export type AndroidBuiltSnapshot = {
  nodes: AndroidRawSnapshotNode[];
  sourceNodes: AndroidUiHierarchy[];
  truncated?: boolean;
  analysis: AndroidSnapshotAnalysis;
};

type AndroidSnapshotBuildState = {
  nodes: AndroidRawSnapshotNode[];
  sourceNodes: AndroidUiHierarchy[];
  maxNodes?: number;
  maxDepth: number;
  options: SnapshotOptions;
  analysis: AndroidSnapshotAnalysis;
  interactiveDescendantMemo: Map<AndroidNode, boolean>;
  truncated: boolean;
};

export function buildUiHierarchySnapshot(
  tree: AndroidUiHierarchy,
  maxNodes: number | undefined,
  options: SnapshotOptions,
): AndroidBuiltSnapshot {
  const requestedDepth = options.depth ?? Number.POSITIVE_INFINITY;
  const state: AndroidSnapshotBuildState = {
    nodes: [],
    sourceNodes: [],
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    // Under --scope, depth is relative to the scope root, which is only known once the tree is
    // presented: walk unbounded and cut after scoping.
    maxDepth: options.scope ? Number.POSITIVE_INFINITY : requestedDepth,
    options,
    analysis: analyzeAndroidTree(tree),
    interactiveDescendantMemo: new Map(),
    truncated: false,
  };

  for (const root of tree.children) {
    walkUiHierarchyNode(state, root, 0);
    if (state.truncated) break;
  }

  const { nodes, sourceNodes } = options.scope
    ? scopePresentedAndroidSnapshot(state, tree.children, options.scope, requestedDepth)
    : state;
  const snapshot = { nodes, sourceNodes, analysis: state.analysis };
  return state.truncated ? { ...snapshot, truncated: true } : snapshot;
}

/**
 * Chrome provenance is stamped HERE, while the tree still has the wrapper that
 * carries it. `shouldIncludeAndroidNode` drops `status_bar*`/`navigation_bar*`
 * wrappers and re-parents their children upward, so downstream classifiers see
 * a clock/battery/wifi leaf sitting next to real content with nothing left to
 * say which region it came from. Recording it on the way down (like
 * `ancestorHittable`) means the answer is identical in every capture shape —
 * `--raw` keeps the wrapper, a default capture drops it, both stamp the same
 * descendants.
 */
function walkUiHierarchyNode(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  depth: number,
  parentIndex?: number,
  ancestorHittable: boolean = false,
  ancestorCollection: boolean = false,
  ancestorSystemChrome: boolean = false,
): void {
  if (state.maxNodes !== undefined && state.nodes.length >= state.maxNodes) {
    state.truncated = true;
    return;
  }
  if (depth > state.maxDepth) return;

  const include = state.options.raw
    ? true
    : shouldIncludeAndroidNode(
        node,
        state.options,
        ancestorHittable,
        hasInteractiveDescendant(state, node),
        ancestorCollection,
      );
  const systemChrome =
    ancestorSystemChrome || isAndroidSystemChromeWindowResourceId(node.identifier);
  const currentIndex = include
    ? appendAndroidSnapshotNode(state, node, parentIndex, systemChrome)
    : parentIndex;
  const nextAncestorHittable = ancestorHittable || isAgentTarget(node);
  const nextAncestorCollection = ancestorCollection || isCollectionContainerType(node.type);
  for (const child of node.children) {
    walkUiHierarchyNode(
      state,
      child,
      depth + 1,
      currentIndex,
      nextAncestorHittable,
      nextAncestorCollection,
      systemChrome,
    );
    if (state.truncated) return;
  }
}

function appendAndroidSnapshotNode(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  parentIndex: number | undefined,
  systemChrome: boolean,
): number {
  const currentIndex = state.nodes.length;
  // Snapshot filtering removes Compose layout wrappers. Keep depth aligned with
  // the retained parent edge, rather than the source tree's depth: otherwise a
  // fixed sibling that follows scroll content can be re-parented under the last
  // retained row by normalizeSnapshotTree's depth fallback (#1377).
  state.sourceNodes.push(node);
  state.nodes.push({
    index: currentIndex,
    type: node.type ?? undefined,
    label: node.label ?? undefined,
    value: node.value ?? undefined,
    identifier: node.identifier ?? undefined,
    bundleId: node.packageName ?? undefined,
    rect: node.rect,
    enabled: node.enabled,
    focused: node.focused,
    visibleToUser: node.visibleToUser,
    hittable: isAgentTarget(node) || undefined,
    depth: compactedAndroidNodeDepth(state.nodes, parentIndex),
    parentIndex,
    ...(node.hiddenContentAbove ? { hiddenContentAbove: true } : {}),
    ...(node.hiddenContentBelow ? { hiddenContentBelow: true } : {}),
    ...(systemChrome ? { systemChrome: true } : {}),
  });
  return currentIndex;
}

function compactedAndroidNodeDepth(
  nodes: AndroidRawSnapshotNode[],
  parentIndex: number | undefined,
): number {
  return parentIndex === undefined ? 0 : (nodes[parentIndex]?.depth ?? -1) + 1;
}

function hasInteractiveDescendant(state: AndroidSnapshotBuildState, node: AndroidNode): boolean {
  const cached = state.interactiveDescendantMemo.get(node);
  if (cached !== undefined) return cached;
  for (const child of node.children) {
    if (
      child.visibleToUser !== false &&
      (isAgentTarget(child) || hasInteractiveDescendant(state, child))
    ) {
      state.interactiveDescendantMemo.set(node, true);
      return true;
    }
  }
  state.interactiveDescendantMemo.set(node, false);
  return false;
}

function readNodeAttributes(node: string): Omit<AndroidUiNodeMetadata, 'rect'> {
  const attrs = parseXmlNodeAttributes(node);
  const getAttr = (name: string): string | null => readXmlAttr(attrs, name);
  const boolAttr = (name: string): boolean | undefined => {
    const raw = getAttr(name);
    if (raw === null) return undefined;
    return raw === 'true';
  };
  const numberAttr = (name: string): number | undefined => {
    const raw = getAttr(name);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const optionalNumberAttr = <Key extends keyof AndroidUiNodeMetadata>(
    key: Key,
    name: string,
  ): Pick<AndroidUiNodeMetadata, Key> | {} => {
    const value = numberAttr(name);
    return value === undefined ? {} : { [key]: value };
  };
  const optionalRectAttr = <Key extends keyof AndroidUiNodeMetadata>(
    key: Key,
    name: string,
  ): Pick<AndroidUiNodeMetadata, Key> | {} => {
    const value = parseBounds(getAttr(name));
    return value === undefined ? {} : { [key]: value };
  };
  const optionalBoolAttr = <Key extends keyof AndroidUiNodeMetadata>(
    key: Key,
    name: string,
  ): Pick<AndroidUiNodeMetadata, Key> | {} => {
    const value = boolAttr(name);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    text: getAttr('text'),
    desc: getAttr('content-desc'),
    resourceId: getAttr('resource-id'),
    packageName: getAttr('package'),
    className: getAttr('class'),
    bounds: getAttr('bounds'),
    clickable: boolAttr('clickable'),
    enabled: boolAttr('enabled'),
    focusable: boolAttr('focusable'),
    focused: boolAttr('focused'),
    password: boolAttr('password'),
    ...optionalBoolAttr('visibleToUser', 'visible-to-user'),
    ...optionalNumberAttr('drawingOrder', 'drawing-order'),
    ...optionalBoolAttr('scrollable', 'scrollable'),
    ...optionalBoolAttr('canScrollForward', 'can-scroll-forward'),
    ...optionalBoolAttr('canScrollBackward', 'can-scroll-backward'),
    ...optionalNumberAttr('windowIndex', 'window-index'),
    ...optionalNumberAttr('windowType', 'window-type'),
    ...optionalNumberAttr('windowLayer', 'window-layer'),
    ...optionalBoolAttr('windowActive', 'window-active'),
    ...optionalBoolAttr('windowFocused', 'window-focused'),
    ...optionalRectAttr('windowRect', 'window-bounds'),
  };
}

function parseXmlNodeAttributes(node: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const start = node.indexOf(' ');
  const end = node.lastIndexOf('>');
  if (start < 0 || end <= start) return attrs;

  let cursor = start;
  while (cursor < end) {
    const parsed = readNextXmlAttribute(node, cursor, end);
    if (!parsed) break;
    attrs.set(parsed.name, parsed.value);
    cursor = parsed.nextCursor;
  }

  return attrs;
}

type ParsedXmlAttribute = {
  name: string;
  value: string;
  nextCursor: number;
};

function readNextXmlAttribute(
  node: string,
  cursor: number,
  end: number,
): ParsedXmlAttribute | undefined {
  cursor = skipXmlWhitespace(node, cursor, end);
  if (cursor >= end || isXmlNodeEnd(node[cursor])) return undefined;

  const nameStart = cursor;
  cursor = skipXmlAttributeName(node, cursor, end);
  const name = node.slice(nameStart, cursor);
  cursor = skipXmlWhitespace(node, cursor, end);
  if (!name || node[cursor] !== '=') return undefined;
  cursor = skipXmlWhitespace(node, cursor + 1, end);

  const quote = node[cursor];
  if (!isXmlQuote(quote)) return undefined;
  const valueStart = cursor + 1;
  const valueEnd = node.indexOf(quote, valueStart);
  if (valueEnd < 0 || valueEnd >= end) return undefined;
  return {
    name,
    value: decodeXmlCharacterReferences(node.slice(valueStart, valueEnd)),
    nextCursor: valueEnd + 1,
  };
}

function skipXmlAttributeName(value: string, cursor: number, end: number): number {
  while (cursor < end && !isXmlAttributeNameTerminator(value[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor;
}

function skipXmlWhitespace(value: string, cursor: number, end: number): number {
  while (cursor < end && isXmlWhitespace(value[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor;
}

function isXmlNodeEnd(char: string | undefined): boolean {
  return char === '/' || char === '>';
}

function isXmlQuote(char: string | undefined): char is '"' | "'" {
  return char === '"' || char === "'";
}

function isXmlWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function isXmlAttributeNameTerminator(char: string): boolean {
  return char === '=' || char === '/' || char === '>' || isXmlWhitespace(char);
}

function readXmlAttr(attrs: Map<string, string>, name: string): string | null {
  return attrs.get(name) ?? null;
}

export type AndroidUiHierarchy = {
  type: string | null;
  label: string | null;
  value: string | null;
  identifier: string | null;
  packageName: string | null;
  rect?: Rect;
  enabled?: boolean;
  visibleToUser?: boolean;
  drawingOrder?: number;
  focused?: boolean;
  // Two independent facts, never collapsed, and never undefined: the helper omits false attributes
  // while stock UiAutomator writes them out, so reading an absent attribute as a value gave two
  // encodings of one control opposite answers.
  clickable: boolean;
  focusable: boolean;
  depth: number;
  parentIndex?: number;
  hiddenContentAbove?: boolean;
  hiddenContentBelow?: boolean;
  scrollable?: boolean;
  canScrollForward?: boolean;
  canScrollBackward?: boolean;
  windowIndex?: number;
  windowType?: number;
  windowLayer?: number;
  windowActive?: boolean;
  windowFocused?: boolean;
  windowRect?: Rect;
  children: AndroidNode[];
};

type AndroidNode = AndroidUiHierarchy;

type AndroidNodeInclusionInfo = {
  type: string;
  hasMeaningfulText: boolean;
  hasMeaningfulId: boolean;
  isStructural: boolean;
  isVisual: boolean;
};

type AndroidFootprint = {
  /** Boxes of what the subtree paints: touch targets, scrollables and labelled leaves. */
  paints: Rect[];
  /** Boxes of what an agent would see of the subtree: `paints` plus labelled/identified nodes. */
  shows: Rect[];
  hasAgentTarget: boolean;
};

type AndroidTreePruneState = {
  footprintMemo: WeakMap<AndroidNode, AndroidFootprint>;
};

type AndroidCoveringCandidate = {
  node: AndroidNode;
  drawingOrder: number;
  footprint: Rect[];
};

const ANDROID_WINDOW_TYPE_APPLICATION = 1;

export function parseUiHierarchyTree(xml: string): AndroidUiHierarchy {
  const root: AndroidUiHierarchy = {
    type: null,
    label: null,
    value: null,
    identifier: null,
    packageName: null,
    clickable: false,
    focusable: false,
    depth: -1,
    children: [],
  };
  const stack: AndroidNode[] = [root];
  const tokenRegex = /<node\b[^>]*>|<\/node>/g;
  let match = tokenRegex.exec(xml);
  while (match) {
    const token = match[0];
    if (token.startsWith('</node')) {
      if (stack.length > 1) stack.pop();
      match = tokenRegex.exec(xml);
      continue;
    }
    const attrs = readAndroidUiNodeMetadata(token);
    const parent = stack[stack.length - 1]!;
    const node: AndroidUiHierarchy = {
      type: attrs.className,
      label: attrs.text || attrs.desc,
      value: attrs.text,
      identifier: attrs.resourceId,
      packageName: attrs.packageName,
      rect: attrs.rect,
      enabled: attrs.enabled,
      focused: attrs.focused,
      visibleToUser: attrs.visibleToUser,
      drawingOrder: attrs.drawingOrder,
      clickable: attrs.clickable === true,
      focusable: attrs.focusable === true,
      scrollable: attrs.scrollable,
      canScrollForward: attrs.canScrollForward,
      canScrollBackward: attrs.canScrollBackward,
      windowIndex: attrs.windowIndex,
      windowType: attrs.windowType,
      windowLayer: attrs.windowLayer,
      windowActive: attrs.windowActive,
      windowFocused: attrs.windowFocused,
      windowRect: attrs.windowRect,
      depth: parent.depth + 1,
      parentIndex: undefined,
      children: [],
    };
    parent.children.push(node);
    if (!token.endsWith('/>')) {
      stack.push(node);
    }
    match = tokenRegex.exec(xml);
  }
  // Raw Android snapshots are uncollapsed, but still agent-visible. The helper can expose
  // aria-hidden/no-hide-descendants children, so prune nodes Android marks hidden to users.
  pruneAndroidInvisibleSubtrees(root);
  discardInactiveAndroidApplicationWindows(root);
  // UiAutomation can expose covered React Native navigation surfaces in the same accessibility
  // window. If a higher drawing-order sibling covers them, agents should see the foreground surface.
  pruneAndroidCoveredSubtrees(root, { footprintMemo: new WeakMap() });
  applyAndroidScrollActionHints(root);
  return root;
}

/** A node a touch can act on. */
function isTouchTarget(node: AndroidNode): boolean {
  return node.clickable;
}

/** A node D-pad/keyboard traversal can land on. Normal for TV controls, which are rarely clickable. */
function isFocusTarget(node: AndroidNode): boolean {
  return node.focusable || node.focused === true;
}

/** A node an agent can drive by either input model. This is what the public `hittable` projects. */
function isAgentTarget(node: AndroidNode): boolean {
  return isTouchTarget(node) || isFocusTarget(node);
}

/** Text or an address an agent can read or select by. */
function hasSemanticContent(node: AndroidNode): boolean {
  return hasMeaningfulLabel(node) || hasMeaningfulIdentifier(node);
}

/**
 * Focusability is traversal, not paint (#1733), and a label is an announcement, not paint (#1806):
 * a container's content-desc describes its children and an empty labelled View draws nothing. Only
 * a touch target is direct evidence that a node hides what lies under its box.
 */
function hasDirectOcclusionEvidence(node: AndroidNode): boolean {
  return node.visibleToUser !== false && isTouchTarget(node);
}

/** Evidence the node is a real surface because it contains something an agent could drive. */
function hasDescendantOcclusionEvidence(node: AndroidNode, state: AndroidTreePruneState): boolean {
  return node.children.some(
    (child) => child.visibleToUser !== false && subtreeFootprint(child, state).hasAgentTarget,
  );
}

/**
 * What a subtree paints and what it shows. Paint is the boxes of its touch-consuming surfaces
 * (touch targets, scrollables) and labelled leaves: a full-screen debug overlay
 * holding one floating icon paints only that icon, so it can only hide what sits under the icon,
 * never the whole app behind it (#1806). Rects are kept apart rather than merged into one bounding
 * box: two controls in opposite corners paint two corners, not the screen between them.
 *
 * Shows adds every labelled or identified node — a testID marker or a described container paints
 * nothing, so it never helps a candidate cover, but an agent would still lose it, so it always
 * counts toward what a covered sibling has.
 */
function subtreeFootprint(node: AndroidNode, state: AndroidTreePruneState): AndroidFootprint {
  const cached = state.footprintMemo.get(node);
  if (cached !== undefined) return cached;
  const footprint = hasPositiveRect(node)
    ? footprintWithinBox(node, node.rect, state)
    : childrenFootprint(node, state);
  state.footprintMemo.set(node, footprint);
  return footprint;
}

function footprintWithinBox(
  node: AndroidNode,
  ownBox: Rect,
  state: AndroidTreePruneState,
): AndroidFootprint {
  if (paintsOwnBox(node)) {
    // The whole box is painted; whatever it contains lies inside that box.
    return { paints: [ownBox], shows: [ownBox], hasAgentTarget: isAgentTarget(node) };
  }
  const footprint = childrenFootprint(node, state);
  if (hasSemanticContent(node)) footprint.shows.push(ownBox);
  return footprint;
}

function childrenFootprint(node: AndroidNode, state: AndroidTreePruneState): AndroidFootprint {
  const footprint: AndroidFootprint = {
    paints: [],
    shows: [],
    hasAgentTarget: isAgentTarget(node),
  };
  for (const child of node.children) {
    if (child.visibleToUser === false) continue;
    const childFootprint = subtreeFootprint(child, state);
    footprint.hasAgentTarget ||= childFootprint.hasAgentTarget;
    footprint.paints.push(...childFootprint.paints);
    footprint.shows.push(...childFootprint.shows);
  }
  return footprint;
}

/** Focusability is traversal, not paint (#1733); a container's label describes its children. */
function paintsOwnBox(node: AndroidNode): boolean {
  return (
    isTouchTarget(node) ||
    node.scrollable === true ||
    (node.children.length === 0 && hasMeaningfulLabel(node))
  );
}

/** Fraction of the covered rects' union that lies under the covering rects' union. */
function unionCoverage(coveringRects: Rect[], coveredRects: Rect[]): number {
  const xs = compressedEdges([...coveringRects, ...coveredRects], (rect) => [
    rect.x,
    rect.x + rect.width,
  ]);
  const ys = compressedEdges([...coveringRects, ...coveredRects], (rect) => [
    rect.y,
    rect.y + rect.height,
  ]);
  const covering = markCells(coveringRects, xs, ys);
  const covered = markCells(coveredRects, xs, ys);
  let coveredArea = 0;
  let overlapArea = 0;
  for (let column = 0; column < xs.length - 1; column += 1) {
    const width = xs[column + 1]! - xs[column]!;
    for (let row = 0; row < ys.length - 1; row += 1) {
      const cell = column * (ys.length - 1) + row;
      if (!covered[cell]) continue;
      const area = width * (ys[row + 1]! - ys[row]!);
      coveredArea += area;
      if (covering[cell]) overlapArea += area;
    }
  }
  return coveredArea <= 0 ? 0 : overlapArea / coveredArea;
}

function compressedEdges(rects: Rect[], edgesOf: (rect: Rect) => [number, number]): number[] {
  return [...new Set(rects.flatMap(edgesOf))].sort((left, right) => left - right);
}

function markCells(rects: Rect[], xs: number[], ys: number[]): Uint8Array {
  const rows = ys.length - 1;
  const cells = new Uint8Array((xs.length - 1) * rows);
  for (const rect of rects) {
    const firstColumn = xs.indexOf(rect.x);
    const lastColumn = xs.indexOf(rect.x + rect.width);
    const firstRow = ys.indexOf(rect.y);
    const lastRow = ys.indexOf(rect.y + rect.height);
    for (let column = firstColumn; column < lastColumn; column += 1) {
      cells.fill(1, column * rows + firstRow, column * rows + lastRow);
    }
  }
  return cells;
}

/**
 * A childless sibling that only presents: an RN screen-level testID, or a label drawn inside a
 * higher sibling's box (Telegram's `+` over the country-code EditText). Geometry cannot tell a
 * transparent overlay from an opaque one, and exempting a leaf cannot resurrect a covered surface.
 */
function isPresentationLeaf(node: AndroidNode): boolean {
  return node.children.length === 0 && !isAgentTarget(node) && hasSemanticContent(node);
}

function pruneAndroidInvisibleSubtrees(node: AndroidNode): void {
  let keptCount = 0;
  for (const child of node.children) {
    if (child.visibleToUser === false) continue;
    pruneAndroidInvisibleSubtrees(child);
    node.children[keptCount] = child;
    keptCount += 1;
  }
  if (keptCount < node.children.length) {
    node.children.length = keptCount;
  }
}

function pruneAndroidCoveredSubtrees(node: AndroidNode, state: AndroidTreePruneState): void {
  for (const child of node.children) {
    pruneAndroidCoveredSubtrees(child, state);
  }
  if (node.children.length < 2) {
    return;
  }
  const siblings = node.children;
  const coveringCandidates = siblings
    .map((sibling) => coveringCandidateOf(sibling, state))
    .filter((candidate) => candidate !== null);
  if (coveringCandidates.length === 0) return;
  node.children = siblings.filter((child) =>
    shouldKeepAndroidSibling(child, coveringCandidates, state),
  );
}

function shouldKeepAndroidSibling(
  node: AndroidNode,
  coveringCandidates: AndroidCoveringCandidate[],
  state: AndroidTreePruneState,
): boolean {
  return (
    isPresentationLeaf(node) ||
    !isCoveredByHigherDrawingOrderSibling(node, coveringCandidates, state)
  );
}

/**
 * Covered means everything an agent would see of the sibling lies under what the candidate paints,
 * by actual overlapped area. Comparing footprints rather than boxes lets two stacked screens with the
 * same layout margins still register as covered, while a sparse overlay never condemns a rich
 * screen however far apart its controls sit.
 */
function isCoveredByHigherDrawingOrderSibling(
  node: AndroidNode,
  coveringCandidates: AndroidCoveringCandidate[],
  state: AndroidTreePruneState,
): boolean {
  if (node.visibleToUser === false || node.drawingOrder === undefined || !hasPositiveRect(node)) {
    return false;
  }
  const shows = subtreeFootprint(node, state).shows;
  const coveredRects = shows.length > 0 ? shows : [node.rect];
  for (const candidate of coveringCandidates) {
    if (candidate.node === node || candidate.drawingOrder <= node.drawingOrder) {
      continue;
    }
    if (unionCoverage(candidate.footprint, coveredRects) >= 0.9) {
      return true;
    }
  }
  return false;
}

function hasMeaningfulIdentifier(node: AndroidNode): boolean {
  const identifier = node.identifier?.trim() ?? '';
  return Boolean(identifier && !isGenericAndroidId(identifier));
}

/** The single occlusion classification. Covering is never re-derived from a raw attribute. */
function coveringCandidateOf(
  node: AndroidNode,
  state: AndroidTreePruneState,
): AndroidCoveringCandidate | null {
  const { drawingOrder } = node;
  if (node.visibleToUser === false || drawingOrder === undefined || !hasPositiveRect(node)) {
    return null;
  }
  if (!hasDirectOcclusionEvidence(node) && !hasDescendantOcclusionEvidence(node, state)) {
    return null;
  }
  const footprint = subtreeFootprint(node, state).paints;
  return footprint.length > 0 ? { node, drawingOrder, footprint } : null;
}

function hasMeaningfulLabel(node: AndroidNode): boolean {
  const label = node.label?.trim() ?? '';
  return Boolean(label && !isGenericAndroidId(label));
}

function hasPositiveRect(node: AndroidNode): node is AndroidNode & { rect: Rect } {
  return Boolean(node.rect && node.rect.width > 0 && node.rect.height > 0);
}

function applyAndroidScrollActionHints(root: AndroidUiHierarchy): void {
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop() as AndroidNode;
    stack.push(...node.children);
    if (!isVerticalScrollableNode(node)) continue;
    if (node.canScrollBackward) node.hiddenContentAbove = true;
    if (node.canScrollForward) node.hiddenContentBelow = true;
  }
}

function discardInactiveAndroidApplicationWindows(root: AndroidUiHierarchy): void {
  const windows = root.children.filter(isAndroidWindowRoot);
  if (windows.length < 2) return;

  // Android can keep stale application windows in the accessibility tree after drawer and
  // navigation transitions. Keep dialogs/system windows, but expose only the foreground
  // application layer so agents do not act on content that is hidden from users.
  const foregroundApplicationWindows = windows.filter(
    (window) => isAndroidApplicationWindow(window) && isAndroidForegroundWindow(window),
  );
  if (foregroundApplicationWindows.length === 0) return;
  const foregroundLayer = highestAndroidWindowLayer(foregroundApplicationWindows);

  root.children = root.children.filter((window) => {
    if (!isAndroidApplicationWindow(window)) return true;
    if (!isAndroidForegroundWindow(window)) return false;
    return foregroundLayer === undefined || window.windowLayer === foregroundLayer;
  });
}

function highestAndroidWindowLayer(windows: AndroidNode[]): number | undefined {
  const layers = windows
    .map((window) => window.windowLayer)
    .filter((layer): layer is number => layer !== undefined);
  return layers.length > 0 ? Math.max(...layers) : undefined;
}

function isAndroidWindowRoot(node: AndroidNode): boolean {
  return node.windowIndex !== undefined || node.windowType !== undefined;
}

function isAndroidApplicationWindow(node: AndroidNode): boolean {
  return node.windowType === ANDROID_WINDOW_TYPE_APPLICATION;
}

function isAndroidForegroundWindow(node: AndroidNode): boolean {
  return node.windowActive === true || node.windowFocused === true;
}

function isVerticalScrollableNode(node: AndroidNode): boolean {
  if (!node.scrollable || !isScrollableType(node.type)) return false;
  const type = `${node.type ?? ''}`.toLowerCase();
  if (type.includes('horizontalscrollview')) return false;
  const overflow = estimateChildOverflow(node);
  if (overflow && overflow.horizontal > overflow.vertical && overflow.horizontal > 16) {
    return false;
  }
  return true;
}

function estimateChildOverflow(node: AndroidNode): { horizontal: number; vertical: number } | null {
  if (!node.rect || node.children.length === 0) return null;
  const childRects = node.children.map((child) => child.rect).filter((rect) => rect !== undefined);
  if (childRects.length === 0) return null;
  const minX = Math.min(...childRects.map((rect) => rect.x));
  const maxX = Math.max(...childRects.map((rect) => rect.x + rect.width));
  const minY = Math.min(...childRects.map((rect) => rect.y));
  const maxY = Math.max(...childRects.map((rect) => rect.y + rect.height));
  return {
    horizontal: Math.max(0, maxX - minX - node.rect.width),
    vertical: Math.max(0, maxY - minY - node.rect.height),
  };
}

function shouldIncludeAndroidNode(
  node: AndroidNode,
  options: SnapshotOptions,
  ancestorHittable: boolean,
  descendantHittable: boolean,
  ancestorCollection: boolean,
): boolean {
  if (node.visibleToUser === false) return false;
  const info = getAndroidNodeInclusionInfo(node);
  if (options.interactiveOnly) {
    return shouldIncludeInteractiveAndroidNode(
      node,
      info,
      ancestorHittable,
      descendantHittable,
      ancestorCollection,
    );
  }
  if (info.isStructural || info.isVisual) {
    return shouldIncludeStructuralAndroidNode(node, info, descendantHittable);
  }
  return true;
}

function getAndroidNodeInclusionInfo(node: AndroidNode): AndroidNodeInclusionInfo {
  const type = normalizeAndroidType(node.type);
  const hasText = Boolean(node.label && node.label.trim().length > 0);
  const hasId = Boolean(node.identifier && node.identifier.trim().length > 0);
  return {
    type,
    hasMeaningfulText: hasText && !isGenericAndroidId(node.label ?? ''),
    hasMeaningfulId: hasId && !isGenericAndroidId(node.identifier ?? ''),
    isStructural: isStructuralAndroidType(type),
    isVisual: type === 'imageview' || type === 'imagebutton',
  };
}

function shouldIncludeInteractiveAndroidNode(
  node: AndroidNode,
  info: AndroidNodeInclusionInfo,
  ancestorHittable: boolean,
  descendantHittable: boolean,
  ancestorCollection: boolean,
): boolean {
  if (hasNonPositiveRect(node)) return false;
  if (isAgentTarget(node)) return true;
  if (isScrollableType(info.type) && descendantHittable) return true;
  return shouldIncludeInteractiveProxyNode(
    info,
    ancestorHittable,
    descendantHittable,
    ancestorCollection,
  );
}

function shouldIncludeInteractiveProxyNode(
  info: AndroidNodeInclusionInfo,
  ancestorHittable: boolean,
  descendantHittable: boolean,
  ancestorCollection: boolean,
): boolean {
  if (!info.hasMeaningfulText && !info.hasMeaningfulId) return false;
  if (info.isVisual) return false;
  // Compose commonly places the app-owned content description on a passive
  // `android.view.View` inside the clickable container. Keep that semantic
  // proxy so presentation can associate the label with the action.
  if (info.isStructural && !ancestorCollection && !ancestorHittable) return false;
  return ancestorHittable || descendantHittable || ancestorCollection;
}

function hasNonPositiveRect(node: AndroidNode): boolean {
  return Boolean(node.rect && (node.rect.width <= 0 || node.rect.height <= 0));
}

function shouldIncludeStructuralAndroidNode(
  node: AndroidNode,
  info: AndroidNodeInclusionInfo,
  descendantHittable: boolean,
): boolean {
  if (isAgentTarget(node)) return true;
  if (info.hasMeaningfulText) return true;
  if (info.hasMeaningfulId) return true;
  return descendantHittable;
}

function isCollectionContainerType(type: string | null): boolean {
  if (!type) return false;
  const normalized = normalizeAndroidType(type);
  return (
    normalized.includes('recyclerview') ||
    normalized.includes('listview') ||
    normalized.includes('gridview')
  );
}

function normalizeAndroidType(type: string | null): string {
  if (!type) return '';
  return type.toLowerCase();
}

function isStructuralAndroidType(type: string): boolean {
  const short = type.split('.').pop() ?? type;
  return short.includes('layout') || short === 'viewgroup' || short === 'view';
}

function isGenericAndroidId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[\w.]+:id\/[\w.-]+$/i.test(trimmed);
}

function analyzeAndroidTree(root: AndroidNode): AndroidSnapshotAnalysis {
  let rawNodeCount = 0;
  let maxDepth = 0;
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop() as AndroidNode;
    rawNodeCount += 1;
    maxDepth = Math.max(maxDepth, node.depth);
    stack.push(...node.children);
  }
  return { rawNodeCount, maxDepth };
}
