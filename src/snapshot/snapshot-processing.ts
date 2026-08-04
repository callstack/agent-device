import type { RawSnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import {
  buildSnapshotNodeMap,
  findSnapshotAncestor,
  normalizeType,
} from '@agent-device/contracts/snapshot';
import { extractReadableText } from '../utils/text-surface.ts';

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

export function findNearestHittableAncestor(
  nodes: SnapshotState['nodes'],
  node: SnapshotState['nodes'][number],
): SnapshotState['nodes'][number] | null {
  if (node.hittable) return node;
  return findNearestAncestor(nodes, node, (parent) => parent.hittable === true);
}

/**
 * Returns the nearest ancestor matching `predicate`; false means keep walking.
 */
export function findNearestAncestor(
  nodes: SnapshotState['nodes'],
  node: SnapshotState['nodes'][number],
  predicate: (node: SnapshotState['nodes'][number]) => boolean,
): SnapshotState['nodes'][number] | null {
  const nodesByIndex = buildSnapshotNodeMap(nodes);
  return findSnapshotAncestor(nodes, node, nodesByIndex, (parent) =>
    predicate(parent) ? parent : null,
  );
}

export function extractNodeReadText(node: SnapshotState['nodes'][number]): string {
  return extractReadableText(node);
}
