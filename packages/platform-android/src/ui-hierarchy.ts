import {
  type AndroidSystemChromeProvenance,
  isAndroidSystemChromeWindowResourceId,
} from '@agent-device/contracts/android-system-chrome';
import type { Rect } from '@agent-device/kernel/snapshot';
import { parseBounds } from '@agent-device/kernel/bounds';
import { decodeXmlCharacterReferences } from '@agent-device/xml';
import {
  attachAndroidSiblingOrder,
  type AndroidNode,
  type AndroidUiHierarchy,
} from './ui-hierarchy-node.ts';

export type { AndroidUiHierarchy } from './ui-hierarchy-node.ts';
export { buildUiHierarchySnapshot } from './ui-hierarchy-builder.ts';
export type {
  AndroidBuiltSnapshot,
  AndroidSnapshotAnalysis,
  AndroidUiHierarchySnapshotOptions,
} from './ui-hierarchy-builder.ts';

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
  /**
   * Helper-only: the `text` attribute is the field's HINT, not its value (an empty input's
   * `getText()` returns the hint on modern Android). Absent in raw uiautomator dumps.
   */
  hintShowing?: boolean;
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
  const inChromeNow = (): boolean => openElements.at(-1) === true;
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
  ): Partial<Pick<AndroidUiNodeMetadata, Key>> => {
    const value = numberAttr(name);
    return value === undefined ? {} : ({ [key]: value } as Pick<AndroidUiNodeMetadata, Key>);
  };
  const optionalRectAttr = <Key extends keyof AndroidUiNodeMetadata>(
    key: Key,
    name: string,
  ): Partial<Pick<AndroidUiNodeMetadata, Key>> => {
    const value = parseBounds(getAttr(name));
    return value === undefined ? {} : ({ [key]: value } as Pick<AndroidUiNodeMetadata, Key>);
  };
  const optionalBoolAttr = <Key extends keyof AndroidUiNodeMetadata>(
    key: Key,
    name: string,
  ): Partial<Pick<AndroidUiNodeMetadata, Key>> => {
    const value = boolAttr(name);
    return value === undefined ? {} : ({ [key]: value } as Pick<AndroidUiNodeMetadata, Key>);
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
    ...optionalBoolAttr('hintShowing', 'hint-showing'),
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
    const parent = stack.at(-1)!;
    const node = normalizeAndroidUiHierarchyNode(attrs, parent.depth + 1, parent);
    parent.children.push(node);
    if (!token.endsWith('/>')) {
      stack.push(node);
    }
    match = tokenRegex.exec(xml);
  }
  return root;
}

/**
 * The one anti-corruption boundary from helper/API-specific metadata to presentation input.
 * Acquisition-only facts such as API-24 `drawingOrder` deliberately stop here, so adding a helper
 * or Android-version difference cannot silently change snapshot membership downstream.
 */
function normalizeAndroidUiHierarchyNode(
  attrs: AndroidUiNodeMetadata,
  depth: number,
  parent: AndroidNode,
): AndroidUiHierarchy {
  return attachAndroidSiblingOrder(
    {
      type: attrs.className,
      label: attrs.text || attrs.desc,
      value: attrs.text,
      identifier: attrs.resourceId,
      packageName: attrs.packageName,
      rect: attrs.rect,
      enabled: attrs.enabled,
      focused: attrs.focused,
      visibleToUser: attrs.visibleToUser,
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
      depth,
      parentIndex: undefined,
      children: [],
    },
    attrs.drawingOrder === undefined ? undefined : { parent, order: attrs.drawingOrder },
  );
}
