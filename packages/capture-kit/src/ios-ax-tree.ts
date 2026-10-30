import type { IosViewportEvidence } from '@agent-device/contracts/ios-snapshot';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { resolveIosViewportEvidenceFromRoots } from './ios-snapshot-acquisition.ts';

/**
 * One accessibility text attribute as a provider's accessibility JSON reports it. `AXValue` is a variant
 * attribute — the picker's segmented tabs report the numbers `1`/`0` — and the other text
 * attributes arrive over the same untyped channel, so every one of them is read through
 * {@link scalarText} before it reaches a snapshot node.
 */
type IosTextAttribute = string | number | boolean | null;

export type IosTreeNode = {
  elementType?: string;
  type?: string;
  label?: IosTextAttribute;
  AXLabel?: IosTextAttribute;
  identifier?: IosTextAttribute;
  AXUniqueId?: IosTextAttribute;
  value?: IosTextAttribute;
  AXValue?: IosTextAttribute;
  frame?: { x?: number; y?: number; width?: number; height?: number };
  rect?: { x?: number; y?: number; width?: number; height?: number };
  enabled?: boolean;
  role?: string;
  subrole?: string | null;
  selected?: boolean;
  role_description?: string;
  hittable?: boolean;
  traits?: string[];
  pid?: number;
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
    subrole: node.subrole ?? undefined,
    label: readIosNodeLabel(node),
    value: readIosNodeValue(node),
    identifier: readIosNodeIdentifier(node),
    rect: readIosNodeRect(node),
    enabled: node.enabled,
    selected: readIosNodeSelected(node),
    password: node.subrole === 'AXSecureTextField' ? true : undefined,
    heading: node.traits?.includes('Header') === true ? true : undefined,
    roleDescription: node.role_description,
    hittable: node.hittable,
    depth: options.depth,
    parentIndex: options.parentIndex,
  };
}

function readIosNodeType(node: IosTreeNode): string | undefined {
  return node.elementType ?? node.type;
}

/**
 * Selection from an explicit field or the `Selected` trait the picker reports on a tapped
 * photo. Published as `true` only when selected and omitted otherwise, the shape the Apple
 * tree publishes, so a `selected:` selector cannot tell the producers apart.
 */
function readIosNodeSelected(node: IosTreeNode): true | undefined {
  if (node.selected === true || node.traits?.includes('Selected') === true) return true;
  return undefined;
}

function readIosNodeRole(node: IosTreeNode): string | undefined {
  return node.role ?? readIosNodeType(node);
}

function readIosNodeLabel(node: IosTreeNode): string | undefined {
  return scalarText(node.label) ?? scalarText(node.AXLabel);
}

function readIosNodeValue(node: IosTreeNode): string | undefined {
  return scalarText(node.value) ?? scalarText(node.AXValue);
}

/**
 * One scalar text attribute of the snapshot-node contract. iOS `AXValue` is a variant
 * attribute — the photo picker's segmented tabs report the numbers `1`/`0` — and every
 * attribute arrives over the same untyped JSON channel, so each is read through here
 * before it reaches a node. This mirrors what the Apple tree's scalar reader publishes;
 * unlike that trusted-guest reader, an unexpected type here stringifies rather than
 * throwing, because failing one picker screen is not worth failing the whole snapshot.
 */
function scalarText(value: string | number | boolean | null | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : String(value);
}

function readIosNodeIdentifier(node: IosTreeNode): string | undefined {
  return scalarText(node.identifier) ?? scalarText(node.AXUniqueId);
}

/**
 * The node's screen-space rect, or undefined when the provider omitted a complete one. A component that
 * is not a finite number (an AX sentinel such as an infinite origin) makes the frame unusable.
 */
export function readIosNodeRect(node: IosTreeNode): RawSnapshotNode['rect'] {
  const rect = node.rect ?? node.frame;
  if (
    !rect ||
    !isFiniteNumber(rect.x) ||
    !isFiniteNumber(rect.y) ||
    !isFiniteNumber(rect.width) ||
    !isFiniteNumber(rect.height)
  ) {
    return undefined;
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function readIosNodeChildren(node: IosTreeNode): IosTreeNode[] {
  return node.children ?? node.nodes ?? node.elements ?? [];
}

/**
 * The viewport the tree's own application or window root reports, which is the box every node rect
 * in the same tree was measured in. Undefined when the tree has no such root.
 */
export function resolveIosAxTreeViewport(
  tree: IosTreeNode | IosTreeNode[],
): IosViewportEvidence | undefined {
  return resolveIosViewportEvidenceFromRoots(
    (Array.isArray(tree) ? tree : [tree]).map(viewportRoot),
  );
}

function viewportRoot(node: IosTreeNode) {
  const rawRect = node.rect ?? node.frame;
  const rect = readIosNodeRect(node);
  return {
    type: node.elementType ?? node.type ?? node.role,
    ...(rect ? { rect } : {}),
    rectStatus:
      !rawRect || !rect
        ? ('not-provided' as const)
        : rect.width > 0 && rect.height > 0
          ? ('reported' as const)
          : ('invalid' as const),
  };
}
