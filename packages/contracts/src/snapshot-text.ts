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

/**
 * Presented bar kind, keyed by the normalized kind fragment that identifies it. This module owns
 * the full bar identity, including Android bottom navigation, so every consumer reads one
 * vocabulary; which kinds a scan treats as viewport chrome is the consumer's own choice.
 */
const SNAPSHOT_BAR_KINDS = [
  // First, so a BottomNavigationBar name does not resolve to navigation-bar.
  ['bottomnavigation', 'bottom-navigation'],
  ['tabbar', 'tab-bar'],
  ['toolbar', 'toolbar'],
  ['navigationbar', 'navigation-bar'],
] as const;

type SnapshotBarKind = (typeof SNAPSHOT_BAR_KINDS)[number][1];

/** Reads the bar kind, including bottom navigation, from the captured type, role, and subrole, or nothing for a non-bar node. */
export function snapshotBarKind(
  node: Pick<RawSnapshotNode, 'type' | 'role' | 'subrole'>,
): SnapshotBarKind | undefined {
  const normalized = normalizeNodeKind(node);
  return SNAPSHOT_BAR_KINDS.find(([fragment]) => normalized.includes(fragment))?.[1];
}

/** Identifies native iOS bars whose direct items use platform sizing. */
export function isNativeIosSnapshotBarNode(
  node: Pick<RawSnapshotNode, 'type' | 'role' | 'subrole'>,
): boolean {
  return [node.type, node.role, node.subrole].some((value) => {
    const name = normalizeType(value ?? '').replace(/^ui/, '');
    return SNAPSHOT_BAR_KINDS.some(
      ([fragment, kind]) => kind !== 'bottom-navigation' && name === fragment,
    );
  });
}

export function snapshotNodeKindIncludesAny(
  node: Pick<RawSnapshotNode, 'type' | 'role' | 'subrole'>,
  fragments: readonly string[],
): boolean {
  const normalized = normalizeNodeKind(node);
  return fragments.some((fragment) => normalized.includes(fragment));
}

// Mutation-lane note: the `?? ''` fallback's exact replacement text is not
// observable through this module's public API — every caller only checks
// substring membership against a fixed, known fragment list, and no
// plausible filler text coincides with any of them, so no test can
// distinguish `''` from another non-matching filler here without reaching
// into this private function directly.
function normalizeNodeKind(node: Pick<RawSnapshotNode, 'type' | 'role' | 'subrole'>): string {
  return [node.type, node.role, node.subrole].map((value) => normalizeType(value ?? '')).join(' ');
}

export function isFillableType(type: string, platform: Platform | PublicPlatform): boolean {
  const normalized = normalizeType(type);
  if (!normalized) return true;
  if (platform === 'android') {
    return normalized.includes('edittext') || normalized.includes('autocompletetextview');
  }
  // Web nodes carry ARIA roles: a text input is a `textbox` or `searchbox`.
  if (platform === 'web' && (normalized === 'textbox' || normalized === 'searchbox')) return true;
  return (
    normalized.includes('textfield') ||
    normalized.includes('securetextfield') ||
    normalized.includes('searchfield') ||
    normalized.includes('textview') ||
    normalized.includes('textarea') ||
    normalized === 'search'
  );
}

export function androidFieldValue({
  type,
  text,
  editable,
  password,
  hintShowing,
}: {
  type?: string | null;
  text?: string | null;
  editable?: boolean;
  password?: boolean;
  hintShowing?: boolean;
}): string | undefined {
  const isField =
    editable === true ||
    password === true ||
    (Boolean(normalizeType(type ?? '')) && isFillableType(type ?? '', 'android'));
  if (!isField) return undefined;
  return hintShowing === true ? '' : (text ?? undefined);
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
