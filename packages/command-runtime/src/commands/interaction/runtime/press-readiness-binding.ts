import { areCapturedRectsAtSamePosition } from '@agent-device/kernel/rect-center';
import type { SnapshotNativePressTarget } from '@agent-device/kernel/snapshot';

type TargetBinding = Omit<SnapshotNativePressTarget, 'type'> & { type: string | number };

/** Exact native identity plus the existing capture-rounding band, shared with canonical rechecks. */
export function matchesAuthorizedPressTarget(
  expected: TargetBinding,
  candidate: TargetBinding,
): boolean {
  return (
    expected.type === candidate.type &&
    (expected.valueSource === undefined || expected.valueSource === 'accessibility') &&
    expected.valueSource === candidate.valueSource &&
    (['identifier', 'label', 'value'] as const).every(
      (key) =>
        (key === 'value' && expected.type === 'SecureTextField') ||
        (expected[key] ?? '').trim().normalize('NFC') ===
          (candidate[key] ?? '').trim().normalize('NFC'),
    ) &&
    areCapturedRectsAtSamePosition(expected.rect, candidate.rect)
  );
}
