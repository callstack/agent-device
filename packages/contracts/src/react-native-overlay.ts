import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

export type ReactNativeOverlayNode = Pick<
  RawSnapshotNode,
  'index' | 'type' | 'role' | 'subrole' | 'label' | 'value' | 'identifier' | 'rect' | 'hittable'
>;

const COLLAPSED_WARNING_PREFIX_PATTERNS = [
  /^!,\s+/,
  /^(warn|warning|error):\s+/,
  /\b(?:possible\s+)?unhandled (?:promise )?rejection\b/,
] as const;
const COLLAPSED_WARNING_TEXT_MARKERS = [
  'open debugger to view warnings',
  'getsnapshot should be cached to avoid an infinite loop',
  'unique "key" prop',
  "unique 'key' prop",
  'virtualizedlists should never be nested',
  'failed prop type',
] as const;

export function isReactNativeCollapsedWarningWrapperCandidate(
  node: ReactNativeOverlayNode,
): boolean {
  return (
    isReactNativeCollapsedWarningLabel(node.label?.trim()) && isFullScreenOverlayRect(node.rect)
  );
}

export function isReactNativeCollapsedWarningWrapperWithVisibleBanner(
  node: ReactNativeOverlayNode,
  descendants: ReactNativeOverlayNode[],
): boolean {
  const nodeLabel = node.label?.trim();
  if (!nodeLabel || !isReactNativeCollapsedWarningWrapperCandidate(node)) return false;
  return descendants.some(
    (descendant) =>
      descendant.label?.trim() === nodeLabel && isReactNativeCollapsedWarningBanner(descendant),
  );
}

export function isReactNativeCollapsedWarningLabel(rawLabel: string | undefined): boolean {
  const label = rawLabel?.trim().toLowerCase();
  if (!label) return false;
  return (
    COLLAPSED_WARNING_TEXT_MARKERS.some((marker) => label.includes(marker)) ||
    COLLAPSED_WARNING_PREFIX_PATTERNS.some((pattern) => pattern.test(label))
  );
}

export function isReactNativeOverlayDismissLabel(label: string): boolean {
  return /^dismiss(?:\s*\([^)]*\))?$/i.test(label);
}

export function isReactNativeOverlayMinimizeLabel(label: string): boolean {
  return /^minimi[sz]e(?:\b|\s|\()/i.test(label);
}

export function isReactNativeCollapsedWarningBanner(node: ReactNativeOverlayNode): boolean {
  if (!node.rect) return false;
  return node.rect.width >= 120 && node.rect.height >= 36 && node.rect.height <= 180;
}

function isFullScreenOverlayRect(rect: RawSnapshotNode['rect']): boolean {
  if (!rect) return false;
  return rect.x <= 1 && rect.y <= 1 && rect.width >= 300 && rect.height >= 600;
}
