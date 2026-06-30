import type { RawSnapshotNode } from '../kernel/snapshot.ts';

export function parseWebDriverSource(source: string): RawSnapshotNode[] {
  const nodes: RawSnapshotNode[] = [];
  const stack: number[] = [];
  const tagPattern = /<\s*(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(source))) {
    const closing = match[1] === '/';
    const tagName = match[2] ?? 'Element';
    const attributes = match[3] ?? '';
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs = parseXmlAttributes(attributes);
    const selfClosing = match[4] === '/' || attributes.trimEnd().endsWith('/');
    if (Object.keys(attrs).length === 0) continue;
    const parentIndex = stack.at(-1);
    const node = sourceNodeFromAttributes(
      nodes.length,
      tagName,
      attrs,
      parentIndex,
      parentIndex === undefined ? 0 : (nodes[parentIndex]?.depth ?? 0) + 1,
    );
    nodes.push(node);
    if (!selfClosing) stack.push(node.index);
  }
  return nodes;
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

function parseXmlAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([:\w.-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(input))) {
    attrs[match[1] ?? ''] = decodeXmlEntities(match[2] ?? '');
  }
  return attrs;
}

function rectFromAttributes(attrs: Record<string, string>): RawSnapshotNode['rect'] | undefined {
  const bounds = parseAndroidBounds(attrs.bounds);
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

function parseAndroidBounds(value: string | undefined): RawSnapshotNode['rect'] | undefined {
  if (!value) return undefined;
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value);
  if (!match) return undefined;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    return undefined;
  }
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
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

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
