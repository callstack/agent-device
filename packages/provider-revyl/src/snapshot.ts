import type { SnapshotViewportSize } from '@agent-device/kernel/snapshot';
import { snapshotViewportSizeFrom } from '@agent-device/kernel/rect';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotRuntimeResult } from '@agent-device/contracts/interactor-types';
import { acquireProviderKeyboard } from '@agent-device/contracts/tap-keyboard-occlusion';
import type { IosTreeNode } from '@agent-device/capture-kit/ios-ax-tree';
import type { RevylPlatform } from './device.ts';
import type { RevylSession } from './revyl-session.ts';

/** Reads one Revyl worker's accessibility tree and the box its actions measure. */
export type RevylSnapshotReader = Readonly<{
  /**
   * The worker's `hierarchy` answer as text: a JSON array of accessibility nodes on iOS (the
   * simulator's AX tree, in points) and a uiautomator XML dump on Android.
   */
  readHierarchy(signal?: AbortSignal): Promise<string>;
  /** `health`'s screen size — the box Revyl itself coordinates actions in. */
  viewport(): SnapshotViewportSize | undefined;
}>;

export function createRevylSnapshotReader(session: RevylSession): RevylSnapshotReader {
  return {
    readHierarchy: (signal) => session.client.getWorkerHierarchy(session.runId, signal),
    viewport: () =>
      session.screen === undefined
        ? undefined
        : snapshotViewportSizeFrom({ x: 0, y: 0, ...session.screen }),
  };
}

/**
 * Reads one provider snapshot from one Revyl worker. Each platform's tree goes through the reader that
 * already parses that shape for another provider, so a selector written against a local device resolves
 * here from the same node facts.
 */
export async function captureRevylSnapshot(
  session: Readonly<{ platform: RevylPlatform; runId: string }>,
  reader: RevylSnapshotReader,
  signal?: AbortSignal,
): Promise<SnapshotRuntimeResult> {
  const hierarchy = await reader.readHierarchy(signal);
  // Parsing is not cancelable, so a capture the caller gave up on is refused before it is built.
  signal?.throwIfAborted();
  return session.platform === 'ios'
    ? await captureRevylIosSnapshot(hierarchy, session.runId, reader.viewport())
    : await captureRevylAndroidSnapshot(hierarchy, reader.viewport());
}

/**
 * iOS: the AX node tree goes through the same reader and interpreter as Limrun's iOS tree, and comes
 * back as an acquisition for the host to present. The viewport is the tree's own application root,
 * because that is the box its frames were measured in; without a usable root it is `health`'s screen,
 * which Revyl reports in the same points on iOS.
 */
async function captureRevylIosSnapshot(
  hierarchy: string,
  runId: string,
  screen: SnapshotViewportSize | undefined,
): Promise<SnapshotRuntimeResult> {
  const [{ flattenIosTree, resolveIosAxTreeViewport }, { interpretIosNode }, acquisition] =
    await Promise.all([
      import('@agent-device/capture-kit/ios-ax-tree'),
      import('@agent-device/capture-kit/ios-node-interpretation'),
      import('@agent-device/capture-kit/ios-snapshot-acquisition'),
    ]);
  const tree = parseIosTree(hierarchy);
  const viewport = resolveIosAxTreeViewport(tree, screen);
  return acquisition.createIosSnapshotAcquisition({
    producer: 'revyl-ios-tree',
    ...acquireProviderKeyboard({
      nodes: flattenIosTree(tree).map((node) => interpretIosNode(node)),
      viewport: viewport.kind === 'missing' ? null : viewport.rect,
    }),
    viewport,
    lineage: { targetId: runId },
  });
}

function parseIosTree(hierarchy: string): IosTreeNode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(hierarchy);
  } catch (error) {
    throw invalidIosHierarchy(error);
  }
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  if (!roots.every(isIosTreeNode)) throw invalidIosHierarchy();
  return roots;
}

/** One node object whose child lists, where present, hold node objects all the way down. */
function isIosTreeNode(value: unknown): value is IosTreeNode {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  return [node.children, node.nodes, node.elements].every(
    (children) =>
      children === undefined || (Array.isArray(children) && children.every(isIosTreeNode)),
  );
}

function invalidIosHierarchy(cause?: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Revyl returned an iOS hierarchy that is not an accessibility node tree.',
    { reason: 'provider-response-invalid' },
    cause,
  );
}

/**
 * Android: the uiautomator dump goes through the same parser the WebDriver-backed Android devices
 * use, including the system-bar subtree labelling. The keyboard fact is observed from the tree against
 * the session's screen box, which is the only box Revyl reports.
 */
async function captureRevylAndroidSnapshot(
  xml: string,
  viewport: SnapshotViewportSize | undefined,
): Promise<SnapshotRuntimeResult> {
  const { parseWebDriverAndroidSnapshotNodes } =
    await import('@agent-device/provider-webdriver/android-snapshot');
  const { nodes, keyboard } = acquireProviderKeyboard({
    nodes: parseWebDriverAndroidSnapshotNodes(xml),
    viewport: viewport === undefined ? null : { x: 0, y: 0, ...viewport },
  });
  return {
    backend: 'android',
    producer: 'appium-source',
    nodes,
    keyboard,
    ...(viewport === undefined ? {} : { viewport }),
  } satisfies SnapshotRuntimeResult;
}
