import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { parseBounds } from '@agent-device/kernel/bounds';
import { AppError } from '@agent-device/kernel/errors';
import { parseXmlDocumentSync, type XmlNode } from '@agent-device/xml';

export type WebDriverSourceFacts = Readonly<{
  nodes: RawSnapshotNode[];
  roots: readonly WebDriverSourceRootFact[];
}>;

export type WebDriverSourceRootFact = Readonly<{
  type: string;
  rect?: RawSnapshotNode['rect'];
  rectStatus: 'reported' | 'invalid' | 'not-provided';
}>;

export function parseWebDriverSourceRoots(source: string): XmlNode[] {
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

export function rectFromWebDriverAttributes(
  attrs: Record<string, string>,
): RawSnapshotNode['rect'] | undefined {
  const bounds = parseBounds(attrs.bounds ?? null);
  if (bounds) return bounds;
  const x = numberFromWebDriverAttribute(attrs.x);
  const y = numberFromWebDriverAttribute(attrs.y);
  const width = numberFromWebDriverAttribute(attrs.width);
  const height = numberFromWebDriverAttribute(attrs.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

export function firstWebDriverAttribute(
  attrs: Record<string, string>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = nonEmptyWebDriverAttribute(attrs[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function nonEmptyWebDriverAttribute(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function parseWebDriverBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

export function parseAndroidWebDriverBoolean(
  value: string | undefined,
  defaultValue = false,
): boolean {
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
}

export function isPositiveWebDriverRect(rect: RawSnapshotNode['rect']): boolean {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function numberFromWebDriverAttribute(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function roleFromWebDriverType(
  type: string,
  attrs: Record<string, string>,
): string | undefined {
  return (
    nonEmptyWebDriverAttribute(attrs.class) ??
    nonEmptyWebDriverAttribute(type.replace(/^XCUIElementType/, '').toLowerCase())
  );
}

export function parseWebDriverSourceFacts(source: string): WebDriverSourceFacts {
  const roots = parseWebDriverSourceRoots(source);
  const nodes: RawSnapshotNode[] = [];
  const sourceRoots: WebDriverSourceRootFact[] = [];
  for (const root of roots) {
    appendSourceNodes(nodes, root, undefined, 0, sourceRoots);
  }
  return { nodes, roots: sourceRoots };
}

function appendSourceNodes(
  nodes: RawSnapshotNode[],
  xmlNode: XmlNode,
  parentIndex: number | undefined,
  depth: number,
  sourceRoots: WebDriverSourceRootFact[],
): void {
  const currentIndex = isSourceContainer(xmlNode)
    ? parentIndex
    : appendSourceNode(nodes, xmlNode, parentIndex, depth, sourceRoots);
  const childDepth = currentIndex === parentIndex ? depth : depth + 1;
  for (const child of xmlNode.children) {
    appendSourceNodes(nodes, child, currentIndex, childDepth, sourceRoots);
  }
}

function isSourceContainer(xmlNode: XmlNode): boolean {
  if (Object.keys(xmlNode.attributes).length === 0) return true;
  const name = xmlNode.name.toLowerCase();
  return name === 'hierarchy' || name === 'appiumaut';
}

function appendSourceNode(
  nodes: RawSnapshotNode[],
  xmlNode: XmlNode,
  parentIndex: number | undefined,
  depth: number,
  sourceRoots: WebDriverSourceRootFact[],
): number {
  const index = nodes.length;
  const rect = rectFromWebDriverAttributes(xmlNode.attributes);
  nodes.push(
    sourceNodeFromAttributes(index, xmlNode.name, xmlNode.attributes, parentIndex, depth, rect),
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
  rect: RawSnapshotNode['rect'],
): RawSnapshotNode {
  return {
    index,
    type,
    role: roleFromWebDriverType(type, attrs),
    label: firstWebDriverAttribute(attrs, ['content-desc', 'label', 'text', 'name']),
    value: nonEmptyWebDriverAttribute(attrs.value),
    identifier: firstWebDriverAttribute(attrs, ['resource-id', 'id', 'accessibility-id', 'name']),
    rect,
    ...sourceStateFacts(attrs),
    depth,
    parentIndex,
  };
}

function sourceStateFacts(attrs: Record<string, string>): Partial<RawSnapshotNode> {
  const enabled = parseWebDriverBoolean(attrs.enabled);
  const visibleToUser = parseWebDriverBoolean(attrs.displayed ?? attrs.visible);
  return {
    ...optionalBooleanFact('enabled', enabled),
    ...optionalBooleanFact('selected', parseWebDriverBoolean(attrs.selected)),
    ...optionalBooleanFact('focused', parseWebDriverBoolean(attrs.focused)),
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
  const reportedHittable = parseWebDriverBoolean(reported);
  return reportedHittable === undefined ? {} : { hittable: reportedHittable };
}

function rectStatus(
  attrs: Record<string, string>,
  rect: RawSnapshotNode['rect'],
): WebDriverSourceRootFact['rectStatus'] {
  const hasBoundsAttribute = attrs.bounds !== undefined;
  const hasCompleteRect = ['x', 'y', 'width', 'height'].every((name) => attrs[name] !== undefined);
  if (!hasBoundsAttribute && !hasCompleteRect) return 'not-provided';
  return isPositiveWebDriverRect(rect) ? 'reported' : 'invalid';
}
