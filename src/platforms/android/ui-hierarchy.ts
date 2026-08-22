import type { RawSnapshotNode, Rect, SnapshotOptions } from '@agent-device/kernel/snapshot';
import { parseBounds } from '@agent-device/kernel/bounds';
import { decodeXmlCharacterReferences } from '@agent-device/xml';
import { isScrollableType, normalizeSnapshotScope } from '@agent-device/contracts/snapshot';
import {
  isAgentTarget,
  isGenericAndroidId,
  type AndroidNode,
  type AndroidUiHierarchy,
} from './ui-hierarchy-node.ts';
import { collectAndroidHiddenNodes } from './ui-hierarchy-visibility.ts';
import { scopePresentedAndroidSnapshot } from './ui-hierarchy-scope.ts';

export type { AndroidUiHierarchy } from './ui-hierarchy-node.ts';
import {
  type AndroidSystemChromeProvenance,
  isAndroidSystemChromeWindowResourceId,
} from '@agent-device/contracts/android-system-chrome';

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
  /** Subtrees the regular projection hides (invisible / stale window / covered). Empty for raw. */
  hidden: ReadonlySet<AndroidNode>;
  truncated: boolean;
};

export function buildUiHierarchySnapshot(
  tree: AndroidUiHierarchy,
  maxNodes: number | undefined,
  options: SnapshotOptions,
): AndroidBuiltSnapshot {
  const requestedDepth = options.depth ?? Number.POSITIVE_INFINITY;
  const scope = normalizeSnapshotScope(options.scope);
  const state: AndroidSnapshotBuildState = {
    nodes: [],
    sourceNodes: [],
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    // Under --scope, depth is relative to the scope root, which is only known once the tree is
    // presented: walk unbounded and cut after scoping.
    maxDepth: scope ? Number.POSITIVE_INFINITY : requestedDepth,
    options,
    analysis: analyzeAndroidTree(tree),
    interactiveDescendantMemo: new Map(),
    // C3: raw is the acquired tree (normalization only); regular additionally hides what Android
    // marks invisible, stale application windows, and covered same-window surfaces.
    hidden: options.raw ? new Set() : collectAndroidHiddenNodes(tree),
    truncated: false,
  };

  for (const root of tree.children) {
    walkUiHierarchyNode(state, root, 0);
    if (state.truncated) break;
  }

  const { nodes, sourceNodes } = scope
    ? scopePresentedAndroidSnapshot(state, tree.children, scope, requestedDepth)
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
  if (depth > state.maxDepth || state.hidden.has(node)) return;

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
    ...androidScrollActionHints(node, state.hidden),
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
      !state.hidden.has(child) &&
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

type AndroidNodeInclusionInfo = {
  type: string;
  hasMeaningfulText: boolean;
  hasMeaningfulId: boolean;
  isStructural: boolean;
  isVisual: boolean;
};

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
  return root;
}

/**
 * Scroll-action hints (`hiddenContentAbove/Below`) for the presented node, from the helper's
 * can-scroll-* attributes. Derived per projection over the children that projection shows: the
 * overflow estimate that tells a horizontal list from a vertical one must not count children the
 * regular projection hides, and raw must count them all.
 */
function androidScrollActionHints(
  node: AndroidNode,
  hidden: ReadonlySet<AndroidNode>,
): { hiddenContentAbove?: true; hiddenContentBelow?: true } {
  if (!isVerticalScrollableNode(node, hidden)) return {};
  return {
    ...(node.canScrollBackward ? { hiddenContentAbove: true as const } : {}),
    ...(node.canScrollForward ? { hiddenContentBelow: true as const } : {}),
  };
}

function isVerticalScrollableNode(node: AndroidNode, hidden: ReadonlySet<AndroidNode>): boolean {
  if (!node.scrollable || !isScrollableType(node.type)) return false;
  const type = `${node.type ?? ''}`.toLowerCase();
  if (type.includes('horizontalscrollview')) return false;
  const overflow = estimateChildOverflow(node, hidden);
  if (overflow && overflow.horizontal > overflow.vertical && overflow.horizontal > 16) {
    return false;
  }
  return true;
}

function estimateChildOverflow(
  node: AndroidNode,
  hidden: ReadonlySet<AndroidNode>,
): { horizontal: number; vertical: number } | null {
  const children = node.children.filter(
    (child) => !hidden.has(child) && child.visibleToUser !== false,
  );
  if (!node.rect || children.length === 0) return null;
  const childRects = children.map((child) => child.rect).filter((rect) => rect !== undefined);
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
