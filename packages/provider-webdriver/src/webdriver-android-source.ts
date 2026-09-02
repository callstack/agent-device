import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { XmlNode } from '@agent-device/xml';
import {
  firstWebDriverAttribute,
  isPositiveWebDriverRect,
  nonEmptyWebDriverAttribute,
  parseAndroidWebDriverBoolean,
  parseWebDriverSourceRoots,
  rectFromWebDriverAttributes,
  roleFromWebDriverType,
} from './webdriver-source.ts';

export function parseAndroidWebDriverSource(source: string): RawSnapshotNode[] {
  const roots = parseWebDriverSourceRoots(source);
  const nodes: RawSnapshotNode[] = [];
  for (const root of roots) appendSourceNodes(nodes, root);
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
  for (const child of xmlNode.children) appendSourceNodes(nodes, child, currentIndex, childDepth);
}

function appendSourceNode(
  nodes: RawSnapshotNode[],
  xmlNode: XmlNode,
  parentIndex: number | undefined,
  depth: number,
): number {
  const index = nodes.length;
  const attrs = xmlNode.attributes;
  const rect = rectFromWebDriverAttributes(attrs);
  const enabled = parseAndroidWebDriverBoolean(attrs.enabled, true);
  const visibleToUser = parseAndroidWebDriverBoolean(attrs.displayed ?? attrs.visible, true);
  nodes.push({
    index,
    type: xmlNode.name,
    role: roleFromWebDriverType(xmlNode.name, attrs),
    label: firstWebDriverAttribute(attrs, ['content-desc', 'label', 'text', 'name']),
    value: nonEmptyWebDriverAttribute(attrs.value),
    identifier: firstWebDriverAttribute(attrs, ['resource-id', 'id', 'accessibility-id', 'name']),
    rect,
    enabled,
    selected: parseAndroidWebDriverBoolean(attrs.selected),
    focused: parseAndroidWebDriverBoolean(attrs.focused),
    visibleToUser,
    hittable: visibleToUser && enabled && isPositiveWebDriverRect(rect),
    depth,
    parentIndex,
  });
  return index;
}
