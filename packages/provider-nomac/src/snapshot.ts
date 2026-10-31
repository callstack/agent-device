import {
  flattenIosTree,
  resolveIosAxTreeViewport,
  type IosTreeNode,
} from '@agent-device/capture-kit/ios-ax-tree';
import { interpretIosNode } from '@agent-device/capture-kit/ios-node-interpretation';
import { createIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-acquisition';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import { acquireProviderKeyboard } from '@agent-device/contracts/tap-keyboard-occlusion';
import { AppError } from '@agent-device/kernel/errors';
import type { NomacClient } from './client.ts';

// ui_look names the saved tree on its last line, a NoMac file link on a cloud phone.
const FULL_TREE = /full tree: (https:\/\/\S+)/;

/**
 * The phone's whole tree, captured: `ui_look` saves it (simulator-use's engine, in AXe's keys), NoMac
 * hands it over by link, and capture-kit's AX tree reader reads it as it reads Limrun's and Revyl's.
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
  tree: IosTreeNode[],
  phoneId: string,
): SnapshotRuntimeAcquiredResult {
  const viewport = resolveIosAxTreeViewport(tree);
  const nodes = flattenIosTree(tree).map((node) => interpretIosNode(node));
  return createIosSnapshotAcquisition({
    producer: 'nomac-ios-tree',
    ...acquireProviderKeyboard({
      nodes,
      viewport: viewport.kind === 'missing' ? null : viewport.rect,
    }),
    viewport,
    lineage: { targetId: phoneId },
  });
}

function parseTree(bytes: Buffer): IosTreeNode[] {
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
  const roots = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [parsed]
      : [];
  if (roots.length === 0) {
    throw new AppError('COMMAND_FAILED', "NoMac's phone answered an empty tree.", {
      hint: 'Retry the snapshot; a phone that is still booting reads within seconds.',
    });
  }
  return roots as IosTreeNode[];
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 200) || 'no answer';
}
