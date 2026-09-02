import type { LayeringViolation } from './model.ts';
import { retiredPathViolations } from './retired-zone-policy.ts';

export const SRC_UTILS_RETIREMENT_RULE = 'R14 src-utils-retirement';

const RETIRED_SRC_UTILS_ROOT = 'src/utils';

export function srcUtilsRetirementViolations(trackedFiles: readonly string[]): LayeringViolation[] {
  return retiredPathViolations(
    trackedFiles,
    RETIRED_SRC_UTILS_ROOT,
    SRC_UTILS_RETIREMENT_RULE,
    'src/utils is retired; move this path to its owning package or command zone',
  );
}
