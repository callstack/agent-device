import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

export function normalizeType(type: string): string {
  let normalized = type
    .trim()
    .replaceAll(/XCUIElementType/gi, '')
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

export function isMeaningfulLabel(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(true|false)$/i.test(trimmed)) return false;
  if (/^\d+$/.test(trimmed)) return false;
  return true;
}

/** A non-empty, non-boolean `label`/`value` is a usable overlay or crop signal. */
export function isMeaningfulSignal(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/^(true|false)$/i.test(trimmed);
}

export function extractNodeText(
  node: Pick<RawSnapshotNode, 'label' | 'value' | 'identifier'>,
): string {
  const candidates = [node.label, node.value, node.identifier]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
  return candidates[0] ?? '';
}
