// Target name to validation generator (#1781 B2).
//
// The one place the two domain generators meet: `generate.ts` asks for a target's cases by name
// and gets the classic mutator when the answer is `undefined`. Keeping the lookup here means
// neither domain module imports the other, and adding a validation target is one line.

import type fc from 'fast-check';
import type { FuzzTargetName } from './target-types.ts';
import { cliValidationArb } from './validation-arbitraries-cli.ts';
import { maestroValidationArb } from './validation-arbitraries-maestro.ts';

/** The generator for a validation target, or `undefined` for the classic targets. */
export function validationArbitraryFor(target: FuzzTargetName): fc.Arbitrary<string> | undefined {
  if (target === 'cli-validation') return cliValidationArb;
  if (target === 'maestro-validation') return maestroValidationArb;
  return undefined;
}
