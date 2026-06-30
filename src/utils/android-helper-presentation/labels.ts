import type { SnapshotNode } from '../../kernel/snapshot.ts';
import { displayNodeLabel } from '../../snapshot/snapshot-tree.ts';

export function visibleNodeLabel(node: SnapshotNode): string {
  const label = displayNodeLabel(node);
  if (!label || label !== node.identifier?.trim()) {
    return label;
  }
  if (!isGenericResourceId(label)) {
    return label;
  }
  const type = (node.type ?? '').toLowerCase();
  if (
    type.includes('view') ||
    type.includes('layout') ||
    type.includes('image') ||
    type.includes('list') ||
    type.includes('recyclerview') ||
    type.includes('collection')
  ) {
    return '';
  }
  return label;
}

export function normalizeStructuralNodeLabel(label: string): string | null {
  const normalized = label.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return null;
  if (/^(true|false|\d+)$/.test(normalized)) return null;
  return normalized;
}

function isGenericResourceId(value: string): boolean {
  return /^[\w.]+:id\/[\w.-]+$/i.test(value);
}
