import { areCapturedRectsAtSamePosition } from '@agent-device/kernel/rect-center';
import type { AuthorizedPressTarget } from '@agent-device/contracts/selector-observation-runtime';

/** Exact native identity plus the existing capture-rounding band, shared with canonical rechecks. */
export function matchesAuthorizedPressTarget(
  expected: AuthorizedPressTarget,
  candidate: Omit<AuthorizedPressTarget, 'point'>,
): boolean {
  return (
    expected.type === candidate.type &&
    (['identifier', 'label', 'value'] as const).every(
      (key) =>
        (key === 'value' && expected.type === 'SecureTextField') ||
        (expected[key] ?? '').trim().normalize('NFC') ===
          (candidate[key] ?? '').trim().normalize('NFC'),
    ) &&
    areCapturedRectsAtSamePosition(expected.rect, candidate.rect)
  );
}
