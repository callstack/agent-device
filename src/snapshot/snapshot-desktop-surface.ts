import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotOptions, SnapshotResult } from '@agent-device/contracts/interaction';
import type { CaptureSnapshotInput, SnapshotRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { findNodeByLabel } from './snapshot-node-label.ts';

type SnapshotSurfaceOptions = NonNullable<CaptureSnapshotInput['options']>;

export function createSnapshotRuntimeHost(): SnapshotRuntimeHost {
  return Object.freeze({ captureSurface });
}

export async function captureLinuxSurfaceSnapshot(
  options: CaptureSnapshotInput['options'],
  signal?: AbortSignal,
) {
  const { snapshotLinux } = await import('../platforms/linux/snapshot.ts');
  const result = await snapshotLinux(options?.surface, signal);
  return shapeDesktopSurfaceSnapshot(
    { nodes: result.nodes, truncated: result.truncated, backend: 'linux-atspi' },
    options ?? {},
  );
}

export async function captureMacOsSurfaceSnapshot(
  options: SnapshotSurfaceOptions,
  signal?: AbortSignal,
) {
  const surface = options.surface;
  if (!surface || surface === 'app') {
    throw new TypeError('Apple surface capture requires a non-app macOS surface');
  }
  const { runMacOsSnapshotAction } = await import('../platforms/apple/os/macos/helper.ts');
  const result = await runMacOsSnapshotAction(surface, {
    bundleId: surface === 'menubar' ? options.appBundleId : undefined,
    signal,
  });
  return shapeDesktopSurfaceSnapshot(result, options);
}

const captureSurface: SnapshotRuntimeHost['captureSurface'] = async (device, options, signal) => {
  if (device.platform === 'linux') {
    return await captureLinuxSurfaceSnapshot(options, signal);
  }
  requireMacOsSurfaceDevice(device);
  return await captureMacOsSurfaceSnapshot(options ?? {}, signal);
};

function requireMacOsSurfaceDevice(device: DeviceInfo): void {
  if (device.platform !== 'apple' || device.appleOs !== 'macos') {
    throw new TypeError('Apple surface capture requires a non-app macOS surface');
  }
}

const INTERACTIVE_ROLE_TOKENS = [
  'button',
  'menu',
  'textfield',
  'searchfield',
  'checkbox',
  'radio',
  'switch',
] as const;

/** Applies the legacy desktop-surface projection once for both runtime hosts and legacy capture. */
function shapeDesktopSurfaceSnapshot(
  data: SnapshotResult,
  options: Pick<SnapshotOptions, 'depth' | 'interactiveOnly' | 'scope'>,
): SnapshotResult {
  let nodes = data.nodes ?? [];
  if (options.scope) nodes = scopeSnapshotNodes(nodes, options.scope);
  if (options.interactiveOnly) nodes = filterInteractiveSnapshotNodes(nodes);
  if (typeof options.depth === 'number') nodes = filterSnapshotNodesByDepth(nodes, options.depth);
  return { ...data, nodes };
}

export function scopeSnapshotNodes(nodes: RawSnapshotNode[], scope: string): RawSnapshotNode[] {
  const scopedNodes = attachRefs(nodes);
  const match = findNodeByLabel(scopedNodes, scope);
  if (!match) return [];
  const startIndex = nodes.findIndex((node) => node.index === match.index);
  if (startIndex === -1) return [];
  const startDepth = nodes[startIndex]?.depth ?? 0;
  const slice: RawSnapshotNode[] = [];
  for (let index = startIndex; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    const depth = node.depth ?? 0;
    if (index > startIndex && depth <= startDepth) break;
    slice.push(node);
  }
  return reindexSnapshotNodes(slice, startDepth);
}

function filterInteractiveSnapshotNodes(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  if (nodes.length === 0) return nodes;
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const keepIndexes = new Set<number>();
  for (const node of nodes) {
    if (!isInteractiveSnapshotNode(node)) continue;
    let current: RawSnapshotNode | undefined = node;
    while (current) {
      if (keepIndexes.has(current.index)) break;
      keepIndexes.add(current.index);
      current =
        typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
    }
  }
  if (keepIndexes.size === 0) return nodes;
  return reindexSnapshotNodes(nodes.filter((node) => keepIndexes.has(node.index)));
}

function filterSnapshotNodesByDepth(nodes: RawSnapshotNode[], maxDepth: number): RawSnapshotNode[] {
  return reindexSnapshotNodes(nodes.filter((node) => (node.depth ?? 0) <= maxDepth));
}

function reindexSnapshotNodes(nodes: RawSnapshotNode[], depthOffset = 0): RawSnapshotNode[] {
  const indexMap = new Map<number, number>();
  for (const [index, node] of nodes.entries()) indexMap.set(node.index, index);
  return nodes.map((node, index) => ({
    ...node,
    index,
    depth: Math.max(0, (node.depth ?? 0) - depthOffset),
    parentIndex: typeof node.parentIndex === 'number' ? indexMap.get(node.parentIndex) : undefined,
  }));
}

function isInteractiveSnapshotNode(node: RawSnapshotNode): boolean {
  if ([node.focused, node.hittable, node.rect].some(Boolean)) return true;
  const role = `${node.type ?? ''} ${node.role ?? ''} ${node.subrole ?? ''}`.toLowerCase();
  return INTERACTIVE_ROLE_TOKENS.some((token) => role.includes(token));
}
