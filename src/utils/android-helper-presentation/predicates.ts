import type { SnapshotNode } from '../../kernel/snapshot.ts';

export function isRootNode(node: SnapshotNode): boolean {
  return typeof node.parentIndex !== 'number';
}

export function isEditableNode(node: SnapshotNode): boolean {
  const type = (node.type ?? '').toLowerCase();
  const identifier = (node.identifier ?? '').trim().toLowerCase();
  return type.includes('edittext') || type.includes('textfield') || identifier === 'composer';
}

export function isScrollableNode(node: SnapshotNode): boolean {
  const type = (node.type ?? '').toLowerCase();
  return type.includes('scroll') || type.includes('list') || type.includes('recyclerview');
}
