import { interpretIosNode } from '@agent-device/capture-kit/ios-node-interpretation';
import {
  createIosSnapshotAcquisition,
  resolveIosViewportEvidenceFromRoots,
} from '@agent-device/capture-kit/ios-snapshot-acquisition';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import { acquireProviderKeyboard } from '@agent-device/contracts/tap-keyboard-occlusion';
import { AppError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { NomacClient } from './client.ts';

/**
 * One element of the accessibility tree NoMac's phone serves (simulator-use's engine, in AXe's keys):
 * the element's type, label, id, value, frame in points, and its children.
 */
export type NomacTreeNode = {
  type?: string;
  role?: string;
  subrole?: string | null;
  role_description?: string | null;
  AXLabel?: string | number | boolean | null;
  AXUniqueId?: string | number | boolean | null;
  AXValue?: string | number | boolean | null;
  title?: string | null;
  enabled?: boolean;
  traits?: string[];
  frame?: { x?: number; y?: number; width?: number; height?: number };
  children?: NomacTreeNode[];
};

// ui_look names the saved tree on its last line, a NoMac file link on a cloud phone.
const FULL_TREE = /full tree: (https:\/\/\S+)/;

/**
 * The phone's whole tree, captured: `ui_look` saves it, NoMac hands it over by link, and it becomes
 * the acquisition every iOS snapshot projection reads.
 */
export async function captureNomacIosSnapshot(
  client: NomacClient,
  phoneId: string,
  signal?: AbortSignal,
): Promise<SnapshotRuntimeAcquiredResult> {
  const look = await client.tool(phoneId, 'ui_look', { full: true }, signal);
  const link = FULL_TREE.exec(look.text)?.[1];
  if (look.isError || !link) {
    throw new AppError(
      'COMMAND_FAILED',
      `NoMac's phone could not read its screen: ${firstLine(look.text)}`,
      {
        hint: 'Retry the snapshot; a phone that is still booting reads within seconds.',
      },
    );
  }
  const tree = parseTree(await client.download(link, signal));
  return nomacSnapshotFromTree(tree, phoneId);
}

/** The acquisition for a tree already read, so tests and replays need no phone. */
export function nomacSnapshotFromTree(
  tree: NomacTreeNode[],
  phoneId: string,
): SnapshotRuntimeAcquiredResult {
  // The application element's frame is the screen: derived from the tree, as Limrun's is.
  const evidence = resolveIosViewportEvidenceFromRoots(tree.map(viewportRoot));
  const viewport =
    evidence?.kind === 'reported'
      ? ({ kind: 'derived', rect: evidence.rect } as const)
      : ({ kind: 'missing', reason: 'not-provided' } as const);
  const nodes = flattenNomacTree(tree).map((node) => interpretIosNode(node));
  return createIosSnapshotAcquisition({
    producer: 'nomac-ios-tree',
    ...acquireProviderKeyboard({
      nodes,
      viewport: viewport.kind === 'derived' ? viewport.rect : null,
    }),
    viewport,
    lineage: { targetId: phoneId },
  });
}

export function flattenNomacTree(roots: NomacTreeNode[]): RawSnapshotNode[] {
  const nodes: RawSnapshotNode[] = [];
  const visit = (node: NomacTreeNode, depth: number, parentIndex?: number) => {
    const index = nodes.length;
    nodes.push(mapNode(node, index, depth, parentIndex));
    for (const child of node.children ?? []) visit(child, depth + 1, index);
  };
  for (const root of roots) visit(root, 0);
  return nodes;
}

function mapNode(
  node: NomacTreeNode,
  index: number,
  depth: number,
  parentIndex?: number,
): RawSnapshotNode {
  const type = node.type ?? node.role?.replace(/^AX/, '');
  return {
    index,
    type,
    role: node.role ?? type,
    label: scalarText(node.AXLabel) ?? scalarText(node.title),
    value: scalarText(node.AXValue),
    identifier: scalarText(node.AXUniqueId),
    rect: rectOf(node.frame),
    enabled: node.enabled,
    selected: node.traits?.includes('Selected') === true ? true : undefined,
    password: node.subrole === 'AXSecureTextField' || type === 'SecureTextField' ? true : undefined,
    heading: node.traits?.includes('Header') === true ? true : undefined,
    roleDescription: node.role_description ?? undefined,
    depth,
    parentIndex,
  };
}

function viewportRoot(node: NomacTreeNode) {
  const rect = rectOf(node.frame);
  return {
    type: node.type ?? node.role,
    ...(rect ? { rect } : {}),
    rectStatus:
      !node.frame || !rect
        ? ('not-provided' as const)
        : rect.width > 0 && rect.height > 0
          ? ('reported' as const)
          : ('invalid' as const),
  };
}

function rectOf(frame: NomacTreeNode['frame']) {
  if (!frame) return undefined;
  const { x, y, width, height } = frame;
  if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v)))
    return undefined;
  return { x: x!, y: y!, width: width!, height: height! };
}

/** One text attribute: a number or boolean (a segment's AXValue) as text, empty as absent. */
function scalarText(value: string | number | boolean | null | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : String(value);
}

function parseTree(bytes: Buffer): NomacTreeNode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      "NoMac's phone answered a tree that is not JSON.",
      undefined,
      error,
    );
  }
  if (Array.isArray(parsed)) return parsed as NomacTreeNode[];
  if (parsed && typeof parsed === 'object') return [parsed as NomacTreeNode];
  throw new AppError('COMMAND_FAILED', "NoMac's phone answered an empty tree.");
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 200) || 'no answer';
}
