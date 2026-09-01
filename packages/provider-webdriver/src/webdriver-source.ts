import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import { parseBounds } from '@agent-device/kernel/bounds';
import { parseXmlDocumentSync, type XmlNode } from '@agent-device/xml';

export type WebDriverSourceParseMode = 'facts' | 'legacy-derived';

export type WebDriverSourceFacts = Readonly<{
  nodes: RawSnapshotNode[];
  roots: readonly WebDriverSourceRootFact[];
}>;

export type WebDriverSourceRootFact = Readonly<{
  type: string;
  rect?: RawSnapshotNode['rect'];
  rectStatus: 'reported' | 'invalid' | 'not-provided';
}>;

export function parseWebDriverSource(
  source: string,
  options: Readonly<{ mode: WebDriverSourceParseMode }>,
): RawSnapshotNode[] {
  return parseWebDriverSourceFacts(source, options).nodes;
}

export function parseWebDriverSourceFacts(
  source: string,
  options: Readonly<{ mode: WebDriverSourceParseMode }>,
): WebDriverSourceFacts {
  const roots = parseSourceRoots(source);
  const nodes: RawSnapshotNode[] = [];
  const sourceRoots: WebDriverSourceRootFact[] = [];
  const mode = options.mode;
  for (const root of roots) {
    appendSourceNodes(nodes, root, undefined, 0, mode, sourceRoots);
  }
  return { nodes, roots: sourceRoots };
}

function appendSourceNodes(
  nodes: RawSnapshotNode[],
  xmlNode: XmlNode,
  parentIndex: number | undefined,
  depth: number,
  mode: WebDriverSourceParseMode,
  sourceRoots: WebDriverSourceRootFact[],
): void {
  const currentIndex = isSourceContainer(xmlNode, mode)
    ? parentIndex
    : appendSourceNode(nodes, xmlNode, parentIndex, depth, mode, sourceRoots);
  const childDepth = currentIndex === parentIndex ? depth : depth + 1;
  for (const child of xmlNode.children) {
    appendSourceNodes(nodes, child, currentIndex, childDepth, mode, sourceRoots);
  }
}

function parseSourceRoots(source: string): XmlNode[] {
  try {
    return parseXmlDocumentSync(source);
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to parse WebDriver page source XML: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      error,
    );
  }
}

function isSourceContainer(xmlNode: XmlNode, mode: WebDriverSourceParseMode): boolean {
  if (Object.keys(xmlNode.attributes).length === 0) return true;
  if (mode !== 'facts') return false;
  const name = xmlNode.name.toLowerCase();
  return name === 'hierarchy' || name === 'appiumaut';
}

function appendSourceNode(
  nodes: RawSnapshotNode[],
  xmlNode: XmlNode,
  parentIndex: number | undefined,
  depth: number,
  mode: WebDriverSourceParseMode,
  sourceRoots: WebDriverSourceRootFact[],
): number {
  const index = nodes.length;
  const rect = rectFromAttributes(xmlNode.attributes);
  nodes.push(
    sourceNodeFromAttributes(
      index,
      xmlNode.name,
      xmlNode.attributes,
      parentIndex,
      depth,
      mode,
      rect,
    ),
  );
  if (parentIndex === undefined) {
    sourceRoots.push({
      type: xmlNode.name,
      ...(rect ? { rect } : {}),
      rectStatus: rectStatus(xmlNode.attributes, rect),
    });
  }
  return index;
}

function sourceNodeFromAttributes(
  index: number,
  type: string,
  attrs: Record<string, string>,
  parentIndex: number | undefined,
  depth: number,
  mode: WebDriverSourceParseMode,
  rect: RawSnapshotNode['rect'],
): RawSnapshotNode {
  return {
    index,
    type,
    role: roleFromType(type, attrs),
    label: firstAttribute(attrs, ['content-desc', 'label', 'text', 'name']),
    value: nonEmpty(attrs.value),
    identifier: firstAttribute(attrs, ['resource-id', 'id', 'accessibility-id', 'name']),
    rect,
    ...sourceStateFacts(attrs, rect, mode),
    depth,
    parentIndex,
  };
}

function sourceStateFacts(
  attrs: Record<string, string>,
  rect: RawSnapshotNode['rect'],
  mode: WebDriverSourceParseMode,
): Partial<RawSnapshotNode> {
  if (mode === 'legacy-derived') {
    const enabled = legacyBooleanAttribute(attrs.enabled, true);
    const visibleToUser = legacyBooleanAttribute(attrs.displayed ?? attrs.visible, true);
    return {
      enabled,
      selected: legacyBooleanAttribute(attrs.selected),
      focused: legacyBooleanAttribute(attrs.focused),
      visibleToUser,
      hittable: visibleToUser && enabled && isPositiveRect(rect),
    };
  }

  const enabled = booleanAttribute(attrs.enabled);
  const visibleToUser = booleanAttribute(attrs.displayed ?? attrs.visible);
  return {
    ...optionalBooleanFact('enabled', enabled),
    ...optionalBooleanFact('selected', booleanAttribute(attrs.selected)),
    ...optionalBooleanFact('focused', booleanAttribute(attrs.focused)),
    ...optionalBooleanFact('visibleToUser', visibleToUser),
    ...reportedHittabilityFact(attrs.hittable),
  };
}

function optionalBooleanFact(
  key: 'enabled' | 'selected' | 'focused' | 'visibleToUser',
  value: boolean | undefined,
): Partial<Pick<RawSnapshotNode, 'enabled' | 'selected' | 'focused' | 'visibleToUser'>> {
  return value === undefined ? {} : { [key]: value };
}

function reportedHittabilityFact(
  reported: string | undefined,
): Partial<Pick<RawSnapshotNode, 'hittable'>> {
  const reportedHittable = booleanAttribute(reported);
  return reportedHittable === undefined ? {} : { hittable: reportedHittable };
}

function rectFromAttributes(attrs: Record<string, string>): RawSnapshotNode['rect'] | undefined {
  const bounds = parseBounds(attrs.bounds ?? null);
  if (bounds) return bounds;
  const x = numberAttribute(attrs.x);
  const y = numberAttribute(attrs.y);
  const width = numberAttribute(attrs.width);
  const height = numberAttribute(attrs.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function firstAttribute(
  attrs: Record<string, string>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = nonEmpty(attrs[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function booleanAttribute(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function legacyBooleanAttribute(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
}

function isPositiveRect(rect: RawSnapshotNode['rect']): boolean {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function rectStatus(
  attrs: Record<string, string>,
  rect: RawSnapshotNode['rect'],
): WebDriverSourceRootFact['rectStatus'] {
  const hasBoundsAttribute = attrs.bounds !== undefined;
  const hasCompleteRect = ['x', 'y', 'width', 'height'].every((name) => attrs[name] !== undefined);
  if (!hasBoundsAttribute && !hasCompleteRect) return 'not-provided';
  return isPositiveRect(rect) ? 'reported' : 'invalid';
}

function numberAttribute(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function roleFromType(type: string, attrs: Record<string, string>): string | undefined {
  return nonEmpty(attrs.class) ?? nonEmpty(type.replace(/^XCUIElementType/, '').toLowerCase());
}
