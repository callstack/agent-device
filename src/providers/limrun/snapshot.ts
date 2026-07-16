import fs from 'node:fs';
import path from 'node:path';
import type { RawSnapshotNode } from '../../kernel/snapshot.ts';

type LimrunSelector = { key: 'id' | 'label' | 'text' | 'value'; value: string };

export type IosTreeNode = {
  elementType?: string;
  type?: string;
  label?: string;
  AXLabel?: string | null;
  identifier?: string;
  AXUniqueId?: string | null;
  value?: string;
  AXValue?: string | null;
  frame?: { x?: number; y?: number; width?: number; height?: number };
  rect?: { x?: number; y?: number; width?: number; height?: number };
  enabled?: boolean;
  role?: string;
  selected?: boolean;
  hittable?: boolean;
  children?: IosTreeNode[];
  nodes?: IosTreeNode[];
  elements?: IosTreeNode[];
};

export function flattenIosTree(input: IosTreeNode | IosTreeNode[]): RawSnapshotNode[] {
  const roots = Array.isArray(input) ? input : [input];
  const nodes: RawSnapshotNode[] = [];
  const visit = (node: IosTreeNode, depth: number, parentIndex?: number) => {
    const index = nodes.length;
    nodes.push(mapIosNode(node, { index, depth, parentIndex }));
    for (const child of readIosNodeChildren(node)) {
      visit(child, depth + 1, index);
    }
  };
  for (const root of roots) visit(root, 0);
  return nodes;
}

function mapIosNode(
  node: IosTreeNode,
  options: { index: number; depth: number; parentIndex?: number },
): RawSnapshotNode {
  return {
    index: options.index,
    type: readIosNodeType(node),
    role: readIosNodeRole(node),
    label: readIosNodeLabel(node),
    value: readIosNodeValue(node),
    identifier: readIosNodeIdentifier(node),
    rect: readIosNodeRect(node),
    enabled: node.enabled,
    selected: node.selected,
    hittable: node.hittable,
    depth: options.depth,
    parentIndex: options.parentIndex,
  };
}

function readIosNodeType(node: IosTreeNode): string | undefined {
  return node.elementType ?? node.type;
}

function readIosNodeRole(node: IosTreeNode): string | undefined {
  return node.role ?? readIosNodeType(node);
}

function readIosNodeLabel(node: IosTreeNode): string | undefined {
  return node.label ?? node.AXLabel ?? undefined;
}

function readIosNodeValue(node: IosTreeNode): string | undefined {
  return node.value ?? node.AXValue ?? undefined;
}

function readIosNodeIdentifier(node: IosTreeNode): string | undefined {
  return node.identifier ?? node.AXUniqueId ?? undefined;
}

function readIosNodeRect(node: IosTreeNode): RawSnapshotNode['rect'] {
  const rect = node.rect ?? node.frame;
  if (
    !rect ||
    typeof rect.x !== 'number' ||
    typeof rect.y !== 'number' ||
    typeof rect.width !== 'number' ||
    typeof rect.height !== 'number'
  ) {
    return undefined;
  }
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function readIosNodeChildren(node: IosTreeNode): IosTreeNode[] {
  return node.children ?? node.nodes ?? node.elements ?? [];
}

export function toIosSelector(selector: LimrunSelector) {
  if (selector.key === 'id') return { accessibilityId: selector.value };
  if (selector.key === 'value') return { value: selector.value };
  // The Limrun iOS tree exposes visible text through AXLabel, so both
  // agent-device label and text selectors target the provider's label field.
  return { label: selector.value };
}

export async function writeBase64File(filePath: string, base64: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
}
