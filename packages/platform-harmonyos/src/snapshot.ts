import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  RawSnapshotNode,
  Rect,
  SnapshotKeyboardBandFact,
} from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotOptions } from '@agent-device/contracts/interactor-types';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';
import {
  makeHostTemporaryDirectory,
  readHostTextFile,
  removeHostDirectory,
} from '@agent-device/host-kit/host-file';
import type { HarmonyHdcRunner } from './hdc.ts';
import { readHarmonyKeyboardBand } from './keyboard-band.ts';

const MAX_NODES = 5_000;

// Gesture planning only reads the Application rect's width/height, but every
// read paid a full layout dump (`uitest dumpLayout` + `file recv` + `rm`).
// Edge scrolls run several passes back to back, so a short memo collapses
// them into one dump while staying far below the cadence where a foreground
// change between passes would matter. Residual risk: a physical rotation or a
// split-screen/multi-window transition inside the TTL window that no hook
// covers yields one stale plan until expiry; agent-device itself cannot
// rotate HarmonyOS (setHarmonyOrientation throws UNSUPPORTED_OPERATION).
const HARMONY_GESTURE_VIEWPORT_MEMO_TTL_MS = 2_000;
const harmonyGestureViewportMemo = createTtlMemo<string, Rect>({
  ttlMs: HARMONY_GESTURE_VIEWPORT_MEMO_TTL_MS,
  // Eager expiry so long-lived daemon processes do not accumulate one entry
  // per device forever.
  scheduleExpiry: true,
});

type ArkUiLayoutNode = {
  attributes?: Record<string, unknown>;
  children?: ArkUiLayoutNode[];
};

/**
 * ArkUI keeps a control's words OUTSIDE the control. A `Toggle` answers with its resource id
 * (`entry_toggle_usb_debug`) and no text; the words on the screen ("USB debugging") are a sibling
 * `Text` of the row container, and every such container reports the same `id` (`SwitchMenuComponent`).
 * An icon-only `Button` answers with neither. So the words a person reads have to be read off the
 * control's row (#4906).
 *
 * The row of a control is the container around it that holds that control and no other control, and
 * hugs it: the settings row of a `Toggle`, the title bar of a back `Button`. The outermost such
 * container wins when several hug the control in a chain. Anything wider holds several controls, and
 * its words would name all of them. Two bounded passes fold the answers for a capture in O(nodes),
 * and nothing outside the row is searched — searching wider is what made an unlabeled back button
 * report the label of a node elsewhere on the screen (#4907).
 *
 * Hugging is what stops the borrow on a screen with a single control: without a size bound, every
 * ancestor of an icon-only FAB up to the capture root holds exactly one control, and the FAB reads
 * the first words of the whole document — the headline far above it — as its own label.
 */
type ArkUiRowIndex = Readonly<{
  /** The first words the node's subtree renders, in document order. */
  textOfSubtree(node: ArkUiLayoutNode): string | undefined;
  /** How many controls (`clickable` nodes) the node's subtree holds. */
  controlsBelow(node: ArkUiLayoutNode): number;
  /** The row container the node sits in, or `undefined` when nothing bounds it. */
  rowOf(node: ArkUiLayoutNode): ArkUiLayoutNode | undefined;
}>;

/**
 * How many multiples of a control's own height a container may reach and still count as that
 * control's row. A row on a device is one line beside the control: across the real captures this
 * shipped against, the container around a leaf control reaches at most 3.5 times the control's
 * height, while the column and screen containers a lone control sits under reach ten or more.
 */
const ARK_UI_ROW_MAX_HEIGHT_MULTIPLE = 4;

/** Whether the container wraps the control the way a row does: it holds it and is barely taller. */
function isArkUiRowOf(container: ArkUiLayoutNode, control: ArkUiLayoutNode): boolean {
  const outer = parseArkUiBounds(stringAttribute(container.attributes ?? {}, 'bounds'));
  const inner = parseArkUiBounds(stringAttribute(control.attributes ?? {}, 'bounds'));
  if (outer === undefined || inner === undefined) return false;
  const insideContainer =
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
  return (
    insideContainer && outer.height <= ARK_UI_ROW_MAX_HEIGHT_MULTIPLE * Math.max(inner.height, 1)
  );
}

function indexArkUiRows(root: ArkUiLayoutNode): ArkUiRowIndex {
  const textOfSubtree = new Map<ArkUiLayoutNode, string | undefined>();
  const controlsBelow = new Map<ArkUiLayoutNode, number>();
  const rowOf = new Map<ArkUiLayoutNode, ArkUiLayoutNode | undefined>();

  // Words below a node beat the node's own `text`, because ArkUI aggregates a whole subtree into a
  // container's `text` ("USB debugging, Enable Debug mode when USB is connected.") — what a screen
  // reader says, rather than the first line shown.
  const fold = (node: ArkUiLayoutNode): string | undefined => {
    let textBelow: string | undefined;
    let controls = 0;
    for (const child of node.children ?? []) {
      const childText = fold(child);
      textBelow ??= childText;
      controls += (controlsBelow.get(child) ?? 0) + (isClickableArkUiNode(child) ? 1 : 0);
    }
    const candidate = textBelow ?? arkUiBorrowableText(node.attributes ?? {});
    textOfSubtree.set(node, candidate);
    controlsBelow.set(node, controls);
    return candidate;
  };
  fold(root);

  // The row is read from the container around the control outwards, and the climb stops at the first
  // container that is not the control's row: one holding another control, or one too tall to be a
  // row. Stopping on the height keeps a lone control on a full-height page without a row, so it
  // borrows nothing instead of the first words of the whole document.
  const assignRows = (node: ArkUiLayoutNode, ancestors: ArkUiLayoutNode[]): void => {
    let row: ArkUiLayoutNode | undefined;
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const container = ancestors[index]!;
      if (controlsBelow.get(container) !== 1 || !isArkUiRowOf(container, node)) break;
      row = container;
    }
    rowOf.set(node, row);
    ancestors.push(node);
    for (const child of node.children ?? []) assignRows(child, ancestors);
    ancestors.pop();
  };
  assignRows(root, []);

  return {
    textOfSubtree: (node) => textOfSubtree.get(node),
    controlsBelow: (node) => controlsBelow.get(node) ?? 0,
    rowOf: (node) => rowOf.get(node),
  };
}

/**
 * The words to label an ArkUI node with, or `undefined` when it names itself. Only a control
 * (`clickable`) borrows: a plain container or `Text` already reports its own words as its `value`.
 *
 * A control that holds another control takes no label: those words are the nested control's own label,
 * and both answering one selector would make every row on the screen ambiguous. A control that borrows
 * reads its own subtree first, then its row.
 */
function arkUiRowLabel(node: ArkUiLayoutNode, rows: ArkUiRowIndex): string | undefined {
  if (!isClickableArkUiNode(node) || arkUiNamesItself(node)) return undefined;
  if (rows.controlsBelow(node) > 0) return undefined;
  const textInside = rows.textOfSubtree(node);
  if (textInside !== undefined) return textInside;
  const row = rows.rowOf(node);
  return row === undefined ? undefined : rows.textOfSubtree(row);
}

function isClickableArkUiNode(node: ArkUiLayoutNode): boolean {
  return node.attributes?.clickable === 'true';
}

/** Whether ArkUI already names this node, through its own text or its accessibility description. */
function arkUiNamesItself(node: ArkUiLayoutNode): boolean {
  const attributes = node.attributes ?? {};
  return arkUiRenderedText(attributes) !== undefined || arkUiDescription(attributes) !== undefined;
}

/** The text ArkUI renders on this node, preferring the spelling it displays. */
function arkUiRenderedText(attributes: Record<string, unknown>): string | undefined {
  return arkUiAttributeValue(attributes, 'text') ?? arkUiAttributeValue(attributes, 'originalText');
}

/**
 * The node's own text when it is worth labeling a neighbouring control with. ArkUI answers clock
 * digits (`"17"`), battery percentages and padding blanks through the same field, and none of them
 * name anything a person would match. A node's own `value` still reports them unchanged.
 */
function arkUiBorrowableText(attributes: Record<string, unknown>): string | undefined {
  const text = arkUiRenderedText(attributes);
  return text === undefined || !/\p{L}/u.test(text) ? undefined : text;
}

/** The accessibility description ArkUI renders for this node, when it renders one. */
function arkUiDescription(attributes: Record<string, unknown>): string | undefined {
  return arkUiAttributeValue(attributes, 'description');
}

function arkUiAttributeValue(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = stringAttribute(attributes, key)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export async function snapshotHarmony(
  hdc: HarmonyHdcRunner,
  device: DeviceInfo,
  options: SnapshotOptions = {},
): Promise<{
  nodes: RawSnapshotNode[];
  truncated?: boolean;
  analysis: { rawNodeCount: number; maxDepth: number };
  keyboard: SnapshotKeyboardBandFact;
}> {
  const snapshot = await captureHarmonyLayout(hdc, device, options);
  // Measured after the tree so the band answers for a screen at least as new as the nodes.
  const keyboard = await readHarmonyKeyboardBand(hdc, device);
  return { ...snapshot, keyboard };
}

async function captureHarmonyLayout(
  hdc: HarmonyHdcRunner,
  device: DeviceInfo,
  options: SnapshotOptions,
): Promise<{
  nodes: RawSnapshotNode[];
  truncated?: boolean;
  analysis: { rawNodeCount: number; maxDepth: number };
}> {
  const token = randomUUID();
  const remotePath = `/data/local/tmp/agent-device-layout-${token}.json`;
  const localDirectory = await makeHostTemporaryDirectory('agent-device-harmony-layout-');
  const localPath = path.join(localDirectory, 'layout.json');
  try {
    await hdc.runShell(device, ['uitest', 'dumpLayout', '-p', remotePath], {
      timeoutMs: 30_000,
    });
    await hdc.run(device, ['file', 'recv', remotePath, localPath], { timeoutMs: 15_000 });
    const raw = await readHostTextFile(localPath);
    return buildHarmonySnapshot(parseHarmonyLayout(raw), options);
  } finally {
    await hdc.runShell(device, ['rm', '-f', remotePath], { allowFailure: true }).catch(() => {});
    await removeHostDirectory(localDirectory);
  }
}

/** Returns the current ArkUI application viewport for coordinate gestures. */
export async function readHarmonyGestureViewport(
  hdc: HarmonyHdcRunner,
  device: DeviceInfo,
): Promise<Rect> {
  const memoKey = device.id;
  const cached = harmonyGestureViewportMemo.get(memoKey);
  if (cached) return cached;
  // Gesture planning reads geometry only, so this capture skips the keyboard-band probe the
  // snapshot command carries.
  const snapshot = await captureHarmonyLayout(hdc, device, {});
  const viewport = snapshot.nodes.find((node) => node.type === 'Application' && node.rect)?.rect;
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'HarmonyOS snapshot did not expose an application viewport',
    );
  }
  harmonyGestureViewportMemo.set(memoKey, viewport);
  return viewport;
}

/**
 * Drop the cached gesture viewport for `device`. Call after anything that can
 * change the foreground app or window geometry (app open/close, home, back,
 * app switcher) so the next plan reads a fresh dump.
 */
export function invalidateHarmonyGestureViewport(device: DeviceInfo): void {
  harmonyGestureViewportMemo.delete(device.id);
}

export function parseHarmonyLayout(raw: string): ArkUiLayoutNode {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('layout root is not an object');
    }
    return parsed as ArkUiLayoutNode;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'HarmonyOS uitest returned an invalid layout JSON document',
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
function buildHarmonySnapshot(
  root: ArkUiLayoutNode,
  options: SnapshotOptions,
): {
  nodes: RawSnapshotNode[];
  truncated?: boolean;
  analysis: { rawNodeCount: number; maxDepth: number };
} {
  const { nodes, truncated, analysis } = collectArkUiNodes(root, {
    maxNodes: MAX_NODES,
    maxDepth: options.depth ?? Number.POSITIVE_INFINITY,
    interactiveOnly: options.interactiveOnly === true,
  });
  return { nodes, ...(truncated ? { truncated: true } : {}), analysis };
}

/**
 * Traversal and emission policy for an ArkUI layout tree, with every bound
 * passed in.
 *
 * Emission and accounting are deliberately separate: emission stops at
 * `maxNodes`, while `analysis` keeps describing the tree the device reported,
 * so the walk continues counting and descending below an omitted node. Halting
 * there would under-report `rawNodeCount` and `maxDepth` for exactly the
 * oversized trees the cap exists for.
 */
export function collectArkUiNodes(
  root: ArkUiLayoutNode,
  policy: { maxNodes: number; maxDepth: number; interactiveOnly: boolean },
): {
  nodes: RawSnapshotNode[];
  truncated: boolean;
  analysis: { rawNodeCount: number; maxDepth: number };
} {
  const nodes: RawSnapshotNode[] = [];
  let rawNodeCount = 0;
  let maxDepth = 0;
  let truncated = false;
  const rows = indexArkUiRows(root);
  const walk = (node: ArkUiLayoutNode, depth: number, parentIndex?: number): void => {
    rawNodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    let currentIndex = parentIndex;
    if (nodes.length >= policy.maxNodes) {
      truncated = true;
    } else {
      const candidate = arkUiNodeFromAttributes(
        node.attributes ?? {},
        nodes.length,
        depth,
        parentIndex,
        arkUiRowLabel(node, rows),
      );
      const include = !policy.interactiveOnly || candidate.hittable === true;
      currentIndex = include ? nodes.push(candidate) - 1 : parentIndex;
    }
    if (depth < policy.maxDepth) {
      for (const child of node.children ?? []) walk(child, depth + 1, currentIndex);
    }
  };
  walk(root, 0);
  return { nodes, truncated, analysis: { rawNodeCount, maxDepth } };
}

function arkUiNodeFromAttributes(
  attributes: Record<string, unknown>,
  index: number,
  depth: number,
  parentIndex: number | undefined,
  rowLabel: string | undefined,
): RawSnapshotNode {
  const text = stringAttribute(attributes, 'text') ?? stringAttribute(attributes, 'originalText');
  const label = arkUiDescription(attributes) ?? rowLabel;
  const identifier = stringAttribute(attributes, 'id') ?? stringAttribute(attributes, 'key');
  const rect = parseArkUiBounds(stringAttribute(attributes, 'bounds'));
  return {
    index,
    // ArkUI calls the application content root simply "root". The shared
    // selector runtime recognizes Application/Window as viewport boundaries,
    // so normalize this transport spelling instead of weakening that contract.
    type:
      stringAttribute(attributes, 'type') === 'root'
        ? 'Application'
        : stringAttribute(attributes, 'type'),
    ...(label ? { label } : {}),
    ...(text ? { value: text } : {}),
    ...(identifier ? { identifier } : {}),
    ...(rect ? { rect } : {}),
    enabled: stringAttribute(attributes, 'enabled') !== 'false',
    focused: stringAttribute(attributes, 'focused') === 'true',
    visibleToUser: stringAttribute(attributes, 'visible') !== 'false',
    hittable: stringAttribute(attributes, 'clickable') === 'true',
    depth,
    ...(parentIndex === undefined ? {} : { parentIndex }),
  };
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' ? value : undefined;
}

export function parseArkUiBounds(value: string | undefined): Rect | undefined {
  if (!value) return undefined;
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value);
  if (!match) return undefined;
  const [, left, top, right, bottom] = match;
  const x = Number(left);
  const y = Number(top);
  const width = Number(right) - x;
  const height = Number(bottom) - y;
  return width >= 0 && height >= 0 ? { x, y, width, height } : undefined;
}
