import type { RawSnapshotNode, Rect, SnapshotOptions } from '../../kernel/snapshot.ts';
import { parseBounds } from '../../utils/bounds.ts';
import { isScrollableType } from '../../utils/scrollable.ts';
import { intersectArea } from '../../utils/screenshot-geometry.ts';

export type AndroidSnapshotAnalysis = {
  rawNodeCount: number;
  maxDepth: number;
};

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
};

export function* androidUiNodes(xml: string): IterableIterator<AndroidUiNodeMetadata> {
  const nodeRegex = /<node\b[^>]*>/g;
  let match = nodeRegex.exec(xml);
  while (match) {
    yield readAndroidUiNodeMetadata(match[0]);
    match = nodeRegex.exec(xml);
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

export function parseUiHierarchy(
  xml: string,
  maxNodes: number | undefined,
  options: SnapshotOptions,
): { nodes: RawSnapshotNode[]; truncated?: boolean; analysis: AndroidSnapshotAnalysis } {
  const tree = parseUiHierarchyTree(xml);
  const { sourceNodes: _sourceNodes, ...snapshot } = buildUiHierarchySnapshot(
    tree,
    maxNodes,
    options,
  );
  return snapshot;
}

export type AndroidBuiltSnapshot = {
  nodes: RawSnapshotNode[];
  sourceNodes: AndroidUiHierarchy[];
  truncated?: boolean;
  analysis: AndroidSnapshotAnalysis;
};

type AndroidSnapshotBuildState = {
  nodes: RawSnapshotNode[];
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
  const state: AndroidSnapshotBuildState = {
    nodes: [],
    sourceNodes: [],
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    maxDepth: options.depth ?? Number.POSITIVE_INFINITY,
    options,
    analysis: analyzeAndroidTree(tree),
    interactiveDescendantMemo: new Map(),
    truncated: false,
  };
  const scopedRoot = options.scope ? findScopeNode(tree, options.scope) : null;
  const roots = scopedRoot ? [scopedRoot] : tree.children;

  for (const root of roots) {
    walkUiHierarchyNode(state, root, 0);
    if (state.truncated) break;
  }

  const snapshot = {
    nodes: state.nodes,
    sourceNodes: state.sourceNodes,
    analysis: state.analysis,
  };
  return state.truncated ? { ...snapshot, truncated: true } : snapshot;
}

function walkUiHierarchyNode(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  depth: number,
  parentIndex?: number,
  ancestorHittable: boolean = false,
  ancestorCollection: boolean = false,
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
  const currentIndex = include
    ? appendAndroidSnapshotNode(state, node, depth, parentIndex)
    : parentIndex;
  const nextAncestorHittable = ancestorHittable || Boolean(node.hittable);
  const nextAncestorCollection = ancestorCollection || isCollectionContainerType(node.type);
  for (const child of node.children) {
    walkUiHierarchyNode(
      state,
      child,
      depth + 1,
      currentIndex,
      nextAncestorHittable,
      nextAncestorCollection,
    );
    if (state.truncated) return;
  }
}

function appendAndroidSnapshotNode(
  state: AndroidSnapshotBuildState,
  node: AndroidNode,
  depth: number,
  parentIndex?: number,
): number {
  const currentIndex = state.nodes.length;
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
    hittable: node.hittable,
    depth,
    parentIndex,
    ...(node.hiddenContentAbove ? { hiddenContentAbove: true } : {}),
    ...(node.hiddenContentBelow ? { hiddenContentBelow: true } : {}),
  });
  return currentIndex;
}

function hasInteractiveDescendant(state: AndroidSnapshotBuildState, node: AndroidNode): boolean {
  const cached = state.interactiveDescendantMemo.get(node);
  if (cached !== undefined) return cached;
  for (const child of node.children) {
    if (
      child.visibleToUser !== false &&
      (child.hittable || hasInteractiveDescendant(state, child))
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
    value: decodeXmlAttributeValue(node.slice(valueStart, valueEnd)),
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

function decodeXmlAttributeValue(value: string): string {
  let decoded = '';
  let cursor = 0;
  while (cursor < value.length) {
    const entityStart = value.indexOf('&', cursor);
    if (entityStart < 0) {
      decoded += value.slice(cursor);
      break;
    }
    decoded += value.slice(cursor, entityStart);
    const entityEnd = value.indexOf(';', entityStart + 1);
    if (entityEnd < 0) {
      decoded += value.slice(entityStart);
      break;
    }
    const rawEntity = value.slice(entityStart + 1, entityEnd);
    decoded += decodeXmlEntity(rawEntity) ?? value.slice(entityStart, entityEnd + 1);
    cursor = entityEnd + 1;
  }
  return decoded;
}

function decodeXmlEntity(entity: string): string | undefined {
  switch (entity) {
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default:
      return decodeNumericXmlEntity(entity);
  }
}

function decodeNumericXmlEntity(entity: string): string | undefined {
  if (!entity.startsWith('#')) return undefined;
  const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
  const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
  if (!digits || !isValidNumericEntityDigits(digits, radix)) return undefined;
  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isFinite(codePoint)) return undefined;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return undefined;
  }
}

function isValidNumericEntityDigits(digits: string, radix: 10 | 16): boolean {
  for (const digit of digits) {
    const code = digit.charCodeAt(0);
    const isDecimal = code >= 48 && code <= 57;
    if (radix === 10) {
      if (!isDecimal) return false;
      continue;
    }
    const isUpperHex = code >= 65 && code <= 70;
    const isLowerHex = code >= 97 && code <= 102;
    if (!isDecimal && !isUpperHex && !isLowerHex) return false;
  }
  return true;
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
  hittable?: boolean;
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

type AndroidTreePruneState = {
  actionableContentMemo: WeakMap<AndroidNode, boolean>;
};

type AndroidCoveringCandidate = AndroidNode & {
  rect: Rect;
  drawingOrder: number;
};

const ANDROID_WINDOW_TYPE_APPLICATION = 1;

export function parseUiHierarchyTree(xml: string): AndroidUiHierarchy {
  const root: AndroidUiHierarchy = {
    type: null,
    label: null,
    value: null,
    identifier: null,
    packageName: null,
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
      hittable: attrs.clickable ?? attrs.focusable,
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
  pruneAndroidCoveredSubtrees(root, { actionableContentMemo: new WeakMap() });
  applyAndroidScrollActionHints(root);
  return root;
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
  const coveringCandidates = siblings.filter((sibling) => canCoverSibling(sibling, state));
  if (coveringCandidates.length === 0) return;
  node.children = siblings.filter(
    (child) => !isCoveredByHigherDrawingOrderSibling(child, coveringCandidates),
  );
}

function isCoveredByHigherDrawingOrderSibling(
  node: AndroidNode,
  coveringCandidates: AndroidCoveringCandidate[],
): boolean {
  if (node.visibleToUser === false || node.drawingOrder === undefined || !hasPositiveRect(node)) {
    return false;
  }

  for (const sibling of coveringCandidates) {
    if (sibling === node || sibling.drawingOrder <= node.drawingOrder) {
      continue;
    }
    if (rectCoverage(sibling.rect, node.rect) >= 0.9) {
      return true;
    }
  }
  return false;
}

function canCoverSibling(
  node: AndroidNode,
  state: AndroidTreePruneState,
): node is AndroidCoveringCandidate {
  return (
    node.visibleToUser !== false &&
    node.drawingOrder !== undefined &&
    hasPositiveRect(node) &&
    (hasOwnAgentVisibleContent(node) || hasActionableDescendant(node, state))
  );
}

function hasOwnAgentVisibleContent(node: AndroidNode): boolean {
  if (node.visibleToUser === false) return false;
  if (node.hittable) return true;
  const label = node.label?.trim() ?? '';
  if (label && !isGenericAndroidId(label)) return true;
  const identifier = node.identifier?.trim() ?? '';
  if (identifier && !isGenericAndroidId(identifier)) return true;
  return false;
}

function hasActionableDescendant(node: AndroidNode, state: AndroidTreePruneState): boolean {
  const cached = state.actionableContentMemo.get(node);
  if (cached !== undefined) return cached;

  const result = node.children.some(
    (child) =>
      child.visibleToUser !== false &&
      (Boolean(child.hittable) || hasActionableDescendant(child, state)),
  );
  state.actionableContentMemo.set(node, result);
  return result;
}

function hasPositiveRect(node: AndroidNode): node is AndroidNode & { rect: Rect } {
  return Boolean(node.rect && node.rect.width > 0 && node.rect.height > 0);
}

function rectCoverage(coveringRect: Rect, targetRect: Rect): number {
  const targetArea = targetRect.width * targetRect.height;
  if (targetArea <= 0) return 0;
  return intersectArea(coveringRect, targetRect) / targetArea;
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
  if (node.focused) return true;
  if (node.hittable) return true;
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
  if (info.isStructural && !ancestorCollection) return false;
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
  if (node.hittable) return true;
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

function findScopeNode(root: AndroidNode, scope: string): AndroidNode | null {
  const query = scope.toLowerCase();
  const queue: AndroidNode[] = [...root.children];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++] as AndroidNode;
    const label = node.label?.toLowerCase() ?? '';
    const value = node.value?.toLowerCase() ?? '';
    const identifier = node.identifier?.toLowerCase() ?? '';
    if (label.includes(query) || value.includes(query) || identifier.includes(query)) {
      return node;
    }
    queue.push(...node.children);
  }
  return null;
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
