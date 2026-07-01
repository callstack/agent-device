import type { Platform, PublicPlatform } from '../kernel/device.ts';
import type { RawSnapshotNode, SnapshotNode, SnapshotState } from '../kernel/snapshot.ts';
import { extractReadableText, normalizeType } from '../utils/text-surface.ts';

export { normalizeType };

export function findNodeByLabel(nodes: SnapshotState['nodes'], label: string) {
  const query = label.toLowerCase();
  return (
    nodes.find((node) => {
      const labelValue = (node.label ?? '').toLowerCase();
      const valueValue = (node.value ?? '').toLowerCase();
      const idValue = (node.identifier ?? '').toLowerCase();
      return labelValue.includes(query) || valueValue.includes(query) || idValue.includes(query);
    }) ?? null
  );
}

export function resolveRefLabel(
  node: SnapshotState['nodes'][number],
  nodes: SnapshotState['nodes'],
): string | undefined {
  const primary = [node.label, node.value, node.identifier]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find((value) => value && value.length > 0);
  if (primary && isMeaningfulLabel(primary)) return primary;
  const fallback = findNearestMeaningfulLabel(node, nodes);
  return fallback ?? (primary && isMeaningfulLabel(primary) ? primary : undefined);
}

function isMeaningfulLabel(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(true|false)$/i.test(trimmed)) return false;
  if (/^\d+$/.test(trimmed)) return false;
  return true;
}

function findNearestMeaningfulLabel(
  target: SnapshotState['nodes'][number],
  nodes: SnapshotState['nodes'],
): string | undefined {
  if (!target.rect) return undefined;
  const targetY = target.rect.y + target.rect.height / 2;
  let best: { label: string; distance: number } | null = null;
  for (const node of nodes) {
    if (!node.rect) continue;
    const label = [node.label, node.value, node.identifier]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value && value.length > 0);
    if (!label || !isMeaningfulLabel(label)) continue;
    const nodeY = node.rect.y + node.rect.height / 2;
    const distance = Math.abs(nodeY - targetY);
    if (!best || distance < best.distance) {
      best = { label, distance };
    }
  }
  return best?.label;
}

export function pruneGroupNodes(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  const skippedDepths: number[] = [];
  const result: RawSnapshotNode[] = [];
  for (const node of nodes) {
    const depth = node.depth ?? 0;
    while (skippedDepths.length > 0 && depth <= skippedDepths[skippedDepths.length - 1]!) {
      skippedDepths.pop();
    }
    const type = normalizeType(node.type ?? '');
    const labelCandidate = [node.label, node.value, node.identifier]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value && value.length > 0);
    const hasMeaningfulLabel = labelCandidate ? isMeaningfulLabel(labelCandidate) : false;
    if ((type === 'group' || type === 'ioscontentgroup') && !hasMeaningfulLabel) {
      skippedDepths.push(depth);
      continue;
    }
    const adjustedDepth = Math.max(0, depth - skippedDepths.length);
    result.push({ ...node, depth: adjustedDepth });
  }
  return result;
}

export function isFillableType(type: string, platform: Platform | PublicPlatform): boolean {
  const normalized = normalizeType(type);
  if (!normalized) return true;
  if (platform === 'android') {
    return normalized.includes('edittext') || normalized.includes('autocompletetextview');
  }
  return (
    normalized.includes('textfield') ||
    normalized.includes('securetextfield') ||
    normalized.includes('searchfield') ||
    normalized.includes('textview') ||
    normalized.includes('textarea') ||
    normalized === 'search'
  );
}

export function findNearestHittableAncestor(
  nodes: SnapshotState['nodes'],
  node: SnapshotState['nodes'][number],
): SnapshotState['nodes'][number] | null {
  if (node.hittable) return node;
  return findNearestAncestor(nodes, node, (parent) => parent.hittable === true);
}

export function buildSnapshotNodeByIndex(nodes: SnapshotState['nodes']): Map<number, SnapshotNode> {
  return new Map(nodes.map((candidate) => [candidate.index, candidate]));
}

/**
 * Walks from the given node through its parent chain and returns the first
 * non-null value produced by `resolve`. Returning null from `resolve` skips
 * that ancestor and continues walking toward the root.
 */
export function findSnapshotAncestor<T>(
  nodes: SnapshotState['nodes'],
  node: SnapshotNode,
  nodeByIndex: ReadonlyMap<number, SnapshotNode>,
  resolve: (ancestor: SnapshotNode) => T | null,
): T | null {
  let current: SnapshotNode | undefined = node;
  const visited = new Set<number>();
  while (typeof current.parentIndex === 'number' && !visited.has(current.index)) {
    visited.add(current.index);
    current = nodeByIndex.get(current.parentIndex) ?? nodes[current.parentIndex];
    if (!current) return null;
    const result = resolve(current);
    if (result !== null) return result;
  }
  return null;
}

export function isDescendantOfSnapshotNode(
  nodes: SnapshotState['nodes'],
  node: SnapshotNode,
  ancestor: SnapshotNode,
  nodeByIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  return Boolean(
    findSnapshotAncestor(nodes, node, nodeByIndex, (candidate) =>
      candidate === ancestor || candidate.index === ancestor.index ? candidate : null,
    ),
  );
}

/**
 * Returns the nearest ancestor matching `predicate`; false means keep walking.
 */
export function findNearestAncestor(
  nodes: SnapshotState['nodes'],
  node: SnapshotState['nodes'][number],
  predicate: (node: SnapshotState['nodes'][number]) => boolean,
): SnapshotState['nodes'][number] | null {
  const nodesByIndex = buildSnapshotNodeByIndex(nodes);
  return findSnapshotAncestor(nodes, node, nodesByIndex, (parent) =>
    predicate(parent) ? parent : null,
  );
}

export function extractNodeText(node: SnapshotState['nodes'][number]): string {
  const candidates = [node.label, node.value, node.identifier]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
  return candidates[0] ?? '';
}

export function extractNodeReadText(node: SnapshotState['nodes'][number]): string {
  return extractReadableText(node);
}
