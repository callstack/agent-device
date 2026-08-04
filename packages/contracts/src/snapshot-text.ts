import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotState } from '@agent-device/kernel/snapshot';

export function normalizeType(type: string): string {
  let normalized = type
    .trim()
    .replace(/XCUIElementType/gi, '')
    .replace(/^AX/, '')
    .toLowerCase();
  const lastSeparator = Math.max(normalized.lastIndexOf('.'), normalized.lastIndexOf('/'));
  if (lastSeparator !== -1) {
    normalized = normalized.slice(lastSeparator + 1);
  }
  return normalized;
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

export function extractNodeText(node: SnapshotState['nodes'][number]): string {
  const candidates = [node.label, node.value, node.identifier]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
  return candidates[0] ?? '';
}
