// Catches: a tracked file reappearing under a retired root — src/utils (R14), the grab-bag zone
//   #2149 retired, or src/replay/ (R71), the caller-side replay code #2151 dissolved into command
//   and CLI owners — a zone with no owner left to hold its invariants, so a module landing there
//   is a silent regression rather than a placement any reviewer would flag by name.
// Evidence: db08548026 (#2149, #2229) enforced the src/utils retirement; caa3dc23f9 (#2151)
//   dissolved caller-side src/replay; 5eebba5fcd (#2240) folded both into this one table.
// Cost: 208 LOC (38 rule + 13 shared retired-zone-policy.ts + 157 test).
// Kill criterion: none enforced today (git tracks any path; only this table rejects one); retire
//   a row only by maintainer decision that its retired root no longer needs a guard — in practice
//   once a full release cycle passes with zero violations under it.

import type { LayeringViolation } from './model.ts';
import { retiredPathViolations } from './retired-zone-policy.ts';

export type RetiredPathRuleId = 'R14' | 'R71';

type RetiredPathRule = Readonly<{ rule: string; prefix: string; guidance: string }>;

/**
 * Retired source directories, keyed by layering rule id. A path is rejected when it is the
 * prefix itself or lives under it; the message names the prefix and points at the owner.
 */
export const RETIRED_PATH_RULES: Readonly<Record<RetiredPathRuleId, RetiredPathRule>> = {
  R14: {
    rule: 'R14 src-utils-retirement',
    prefix: 'src/utils',
    guidance: 'move this path to its owning package or command zone',
  },
  R71: {
    rule: 'R71 replay-ownership',
    prefix: 'src/replay/',
    guidance:
      'caller source acquisition belongs under src/commands/replay/ and replay-test ' +
      'presentation belongs under src/cli/replay-test/.',
  },
};

export function retiredPathRuleViolations(
  id: RetiredPathRuleId,
  files: readonly string[],
): LayeringViolation[] {
  const { rule, prefix, guidance } = RETIRED_PATH_RULES[id];
  return retiredPathViolations(
    files,
    prefix.replace(/\/$/, ''),
    rule,
    `${prefix} is retired; ${guidance}`,
  );
}
