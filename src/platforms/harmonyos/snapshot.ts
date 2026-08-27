import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotOptions } from '@agent-device/contracts/interactor-types';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';
import { runHarmonyHdc } from './hdc.ts';

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

export async function snapshotHarmony(
  device: DeviceInfo,
  options: SnapshotOptions = {},
): Promise<{
  nodes: RawSnapshotNode[];
  truncated?: boolean;
  analysis: { rawNodeCount: number; maxDepth: number };
}> {
  const token = randomUUID();
  const remotePath = `/data/local/tmp/agent-device-layout-${token}.json`;
  const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-harmony-layout-'));
  const localPath = path.join(localDirectory, 'layout.json');
  try {
    await runHarmonyHdc(device, ['shell', 'uitest', 'dumpLayout', '-p', remotePath], {
      timeoutMs: 30_000,
    });
    await runHarmonyHdc(device, ['file', 'recv', remotePath, localPath], { timeoutMs: 15_000 });
    const raw = await fs.readFile(localPath, 'utf8');
    return buildHarmonySnapshot(parseHarmonyLayout(raw), options);
  } finally {
    await runHarmonyHdc(device, ['shell', 'rm', '-f', remotePath], { allowFailure: true }).catch(
      () => {},
    );
    await fs.rm(localDirectory, { recursive: true, force: true });
  }
}

/** Returns the current ArkUI application viewport for coordinate gestures. */
export async function readHarmonyGestureViewport(device: DeviceInfo): Promise<Rect> {
  const memoKey = device.id;
  const cached = harmonyGestureViewportMemo.get(memoKey);
  if (cached) return cached;
  const snapshot = await snapshotHarmony(device);
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
  const walk = (node: ArkUiLayoutNode, depth: number, parentIndex?: number): void => {
    rawNodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    let currentIndex = parentIndex;
    if (nodes.length >= policy.maxNodes) {
      truncated = true;
    } else {
      const attributes = node.attributes ?? {};
      const candidate = arkUiNodeFromAttributes(attributes, nodes.length, depth, parentIndex);
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
): RawSnapshotNode {
  const text = stringAttribute(attributes, 'text') ?? stringAttribute(attributes, 'originalText');
  const label = stringAttribute(attributes, 'description');
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
