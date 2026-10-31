import type { IosViewportEvidence } from '@agent-device/contracts/ios-snapshot';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { resolveIosViewportEvidenceFromRoots } from './ios-snapshot-acquisition.ts';

/**
 * One accessibility text attribute as a remote iOS element tree reports it. `AXValue` is a variant
 * attribute (the photo picker's segmented tabs report the numbers `1`/`0`), and the other text
 * attributes arrive over the same untyped JSON channel, so every one of them is read through
 * {@link scalarText} before it reaches a snapshot node.
 */
type AxeTextAttribute = string | number | boolean | null;

type AxeRect = { x?: number; y?: number; width?: number; height?: number };

/**
 * One element of an AXe-keyed iOS accessibility tree: the JSON a hosted iOS Simulator serves
 * (`AXLabel`, `AXUniqueId`, `AXValue`, `frame`, `role`, `traits`, children), with the plain key
 * spellings some servers use beside them.
 */
export type AxeTreeNode = {
  elementType?: string;
  type?: string;
  label?: AxeTextAttribute;
  AXLabel?: AxeTextAttribute;
  identifier?: AxeTextAttribute;
  AXUniqueId?: AxeTextAttribute;
  value?: AxeTextAttribute;
  AXValue?: AxeTextAttribute;
  frame?: AxeRect;
  rect?: AxeRect;
  enabled?: boolean;
  role?: string;
  subrole?: string | null;
  selected?: boolean;
  role_description?: string;
  hittable?: boolean;
  traits?: string[];
  pid?: number;
  children?: AxeTreeNode[];
  nodes?: AxeTreeNode[];
  elements?: AxeTreeNode[];
};

/** The tree's elements in document order, each with its depth and parent, as snapshot nodes. */
export function flattenAxeTree(input: AxeTreeNode | AxeTreeNode[]): RawSnapshotNode[] {
  const roots = Array.isArray(input) ? input : [input];
  const nodes: RawSnapshotNode[] = [];
  const visit = (node: AxeTreeNode, depth: number, parentIndex?: number) => {
    const index = nodes.length;
    nodes.push(mapAxeNode(node, { index, depth, parentIndex }));
    for (const child of readAxeNodeChildren(node)) {
      visit(child, depth + 1, index);
    }
  };
  for (const root of roots) visit(root, 0);
  return nodes;
}

function mapAxeNode(
  node: AxeTreeNode,
  options: { index: number; depth: number; parentIndex?: number },
): RawSnapshotNode {
  return {
    index: options.index,
    type: readAxeNodeType(node),
    role: readAxeNodeRole(node),
    label: readAxeNodeLabel(node),
    value: readAxeNodeValue(node),
    identifier: readAxeNodeIdentifier(node),
    rect: readAxeNodeRect(node),
    enabled: node.enabled,
    selected: readAxeNodeSelected(node),
    password: node.subrole === 'AXSecureTextField' ? true : undefined,
    heading: node.traits?.includes('Header') === true ? true : undefined,
    roleDescription: node.role_description,
    hittable: node.hittable,
    depth: options.depth,
    parentIndex: options.parentIndex,
  };
}

function readAxeNodeType(node: AxeTreeNode): string | undefined {
  return node.elementType ?? node.type;
}

/**
 * Selection from an explicit field or the `Selected` trait the picker reports on a tapped photo.
 * Published as `true` only when selected and omitted otherwise, the shape the Apple tree publishes,
 * so a `selected:` selector cannot tell the producers apart.
 */
function readAxeNodeSelected(node: AxeTreeNode): true | undefined {
  if (node.selected === true || node.traits?.includes('Selected') === true) return true;
  return undefined;
}

function readAxeNodeRole(node: AxeTreeNode): string | undefined {
  return node.role ?? readAxeNodeType(node);
}

function readAxeNodeLabel(node: AxeTreeNode): string | undefined {
  return scalarText(node.label) ?? scalarText(node.AXLabel);
}

function readAxeNodeValue(node: AxeTreeNode): string | undefined {
  return scalarText(node.value) ?? scalarText(node.AXValue);
}

/**
 * One scalar text attribute of the snapshot-node contract. This mirrors what the Apple tree's
 * scalar reader publishes; unlike that trusted-guest reader, an unexpected type here stringifies
 * rather than throwing, because failing one picker screen is not worth failing the whole snapshot.
 */
function scalarText(value: AxeTextAttribute | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : String(value);
}

function readAxeNodeIdentifier(node: AxeTreeNode): string | undefined {
  return scalarText(node.identifier) ?? scalarText(node.AXUniqueId);
}

/** The node's screen-space rect, or undefined when the tree omitted a complete one. */
export function readAxeNodeRect(node: AxeTreeNode): RawSnapshotNode['rect'] {
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

export function readAxeNodeChildren(node: AxeTreeNode): AxeTreeNode[] {
  return node.children ?? node.nodes ?? node.elements ?? [];
}

/**
 * The screen box the tree's application or window root reports. The root's frame stands for the
 * screen without measuring it, so a reported frame is `derived` evidence; a root whose frame is
 * absent or unusable keeps the reason, and a tree with no root at all answers undefined.
 */
export function readAxeTreeViewport(
  tree: AxeTreeNode | AxeTreeNode[],
): IosViewportEvidence | undefined {
  const evidence = resolveIosViewportEvidenceFromRoots(
    (Array.isArray(tree) ? tree : [tree]).map(axeViewportRoot),
  );
  return evidence?.kind === 'reported' ? { kind: 'derived', rect: evidence.rect } : evidence;
}

function axeViewportRoot(node: AxeTreeNode) {
  const rawRect = node.rect ?? node.frame;
  const rect = completeRect(rawRect);
  return {
    type: node.elementType ?? node.type ?? node.role,
    ...(rect ? { rect } : {}),
    rectStatus: viewportStatus(rawRect, rect),
  };
}

function completeRect(rect: AxeRect | undefined) {
  if (!isCompleteRect(rect)) return undefined;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function isCompleteRect(
  rect: AxeRect | undefined,
): rect is { x: number; y: number; width: number; height: number } {
  return [rect?.x, rect?.y, rect?.width, rect?.height].every(isFiniteNumber);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const viewportStatus = (
  rawRect: AxeRect | undefined,
  rect: ReturnType<typeof completeRect>,
): 'reported' | 'invalid' | 'not-provided' =>
  !rawRect || !rect ? 'not-provided' : rect.width > 0 && rect.height > 0 ? 'reported' : 'invalid';
