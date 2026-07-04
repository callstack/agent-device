import type { RawSnapshotNode } from '../kernel/snapshot.ts';
import { AppError } from '../kernel/errors.ts';
import { parseBounds } from '../utils/bounds.ts';
import { parseXmlDocumentSync, type XmlNode } from '../utils/xml.ts';

export function parseWebDriverSource(source: string): RawSnapshotNode[] {
  let roots: XmlNode[];
  try {
    roots = parseXmlDocumentSync(source);
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to parse WebDriver page source XML: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      error,
    );
  }
  const nodes: RawSnapshotNode[] = [];
  for (const root of roots) {
    appendSourceNodes(nodes, root);
  }
  return nodes;
}

function appendSourceNodes(
  nodes: RawSnapshotNode[],
  xmlNode: XmlNode,
  parentIndex?: number,
  depth = 0,
): void {
  const currentIndex =
    Object.keys(xmlNode.attributes).length === 0
      ? parentIndex
      : appendSourceNode(nodes, xmlNode, parentIndex, depth);
  const childDepth = currentIndex === parentIndex ? depth : depth + 1;
  for (const child of xmlNode.children) {
    appendSourceNodes(nodes, child, currentIndex, childDepth);
  }
}

function appendSourceNode(
  nodes: RawSnapshotNode[],
  xmlNode: XmlNode,
  parentIndex: number | undefined,
  depth: number,
): number {
  const index = nodes.length;
  nodes.push(sourceNodeFromAttributes(index, xmlNode.name, xmlNode.attributes, parentIndex, depth));
  return index;
}

function sourceNodeFromAttributes(
  index: number,
  type: string,
  attrs: Record<string, string>,
  parentIndex: number | undefined,
  depth: number,
): RawSnapshotNode {
  const rect = rectFromAttributes(attrs);
  const enabled = booleanAttribute(attrs.enabled, true);
  const visibleToUser = booleanAttribute(attrs.displayed ?? attrs.visible, true);
  return {
    index,
    type,
    role: roleFromType(type, attrs),
    label: firstAttribute(attrs, ['content-desc', 'label', 'text', 'name']),
    value: nonEmpty(attrs.value),
    identifier: firstAttribute(attrs, ['resource-id', 'id', 'accessibility-id', 'name']),
    rect,
    enabled,
    selected: booleanAttribute(attrs.selected),
    focused: booleanAttribute(attrs.focused),
    visibleToUser,
    hittable: visibleToUser && enabled && rect !== undefined && rect.width > 0 && rect.height > 0,
    depth,
    parentIndex,
  };
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

function booleanAttribute(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
}

function numberAttribute(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function roleFromType(type: string, attrs: Record<string, string>): string | undefined {
  return nonEmpty(attrs.class) ?? nonEmpty(type.replace(/^XCUIElementType/, '').toLowerCase());
}
