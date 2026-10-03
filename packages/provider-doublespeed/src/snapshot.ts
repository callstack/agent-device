import fs from 'node:fs';
import path from 'node:path';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { DoublespeedElementSelector, DoublespeedTreeNode } from './session-client.ts';

type SnapshotSelector = { key: 'id' | 'label' | 'text' | 'value'; value: string };

export function flattenDoublespeedTree(roots: readonly DoublespeedTreeNode[]): RawSnapshotNode[] {
  const nodes: RawSnapshotNode[] = [];
  const visit = (node: DoublespeedTreeNode, depth: number, parentIndex?: number) => {
    const index = nodes.length;
    nodes.push(mapNode(node, { index, depth, parentIndex }));
    for (const child of node.children ?? []) visit(child, depth + 1, index);
  };
  for (const root of roots) visit(root, 0);
  return nodes;
}

function mapNode(
  node: DoublespeedTreeNode,
  options: { index: number; depth: number; parentIndex?: number },
): RawSnapshotNode {
  return {
    index: options.index,
    type: node.type,
    role: node.type,
    label: node.label,
    value: node.value,
    identifier: node.identifier,
    rect: readRect(node),
    enabled: node.enabled,
    visibleToUser: node.visible,
    depth: options.depth,
    parentIndex: options.parentIndex,
  };
}

function readRect(node: DoublespeedTreeNode): RawSnapshotNode['rect'] {
  const frame = node.frame;
  if (
    !frame ||
    typeof frame.x !== 'number' ||
    typeof frame.y !== 'number' ||
    typeof frame.width !== 'number' ||
    typeof frame.height !== 'number'
  ) {
    return undefined;
  }
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

/** The session tree exposes visible text through `label`, so text selectors target that field. */
export function toDoublespeedSelector(selector: SnapshotSelector): DoublespeedElementSelector {
  if (selector.key === 'id') return { accessibilityId: selector.value };
  if (selector.key === 'value') return { value: selector.value };
  return { label: selector.value };
}

export async function writeBase64File(filePath: string, base64: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
}
