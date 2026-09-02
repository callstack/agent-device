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
