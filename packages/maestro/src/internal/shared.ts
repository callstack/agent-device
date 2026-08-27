import type { SnapshotNode } from '@agent-device/kernel/snapshot';

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export { canonicalJson } from '@agent-device/kernel/collections';
export { pointInsideRect } from '@agent-device/kernel/rect-center';

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function extractNodeText(node: SnapshotNode): string {
  return (
    [node.label, node.value, node.identifier]
      .find((candidate) => typeof candidate === 'string' && candidate.length > 0)
      ?.trim() ?? ''
  );
}
