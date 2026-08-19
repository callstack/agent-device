// The contract every validation generator owes, as a reusable suite (#1781 B2).
//
// Both generators must be replayable, must hold every expectation they plant against the real
// parser, and must keep firing every class they declare. That is one contract, so it is asserted
// from one place — the domain-specific reach and layer assertions stay in each generator's own
// test file, which is where the knowledge that differs lives.

import type fc from 'fast-check';
import { sample } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeFailure } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';
import type { ParserTargetName } from './target-types.ts';
import { decodeValidationCase } from './validation-case.ts';

export function describeGeneratorContract(input: {
  targetName: ParserTargetName;
  arbitrary: fc.Arbitrary<string>;
  /** The classes the generator declares; coverage is checked against it, not a snapshot. */
  declaredClasses: readonly string[];
  sample: readonly string[];
}): void {
  const { targetName, arbitrary, declaredClasses, sample: cases } = input;
  const target = getFuzzTarget(targetName);

  describe(`${targetName} generator`, () => {
    it('is deterministic for a seed, so a reported counterexample replays', () => {
      const again = sample(arbitrary, { numRuns: 32, seed: 7 });
      expect(again).toEqual(sample(arbitrary, { numRuns: 32, seed: 7 }));
      expect(again).not.toEqual(sample(arbitrary, { numRuns: 32, seed: 8 }));
    });

    it('produces decodable envelopes whose expectations hold on a healthy tree', () => {
      const failures = [];
      for (const entry of cases) {
        expect(decodeValidationCase(entry)).not.toBeNull();
        const failure = target.check!(entry);
        if (failure) failures.push(describeFailure(failure));
      }
      expect(failures).toEqual([]);
    });

    // Checked against the generator's own declaration rather than a pinned snapshot: a class that
    // stops firing is dead coverage, and a snapshot of the class list only restates the source.
    it('fires every class it declares, and still generates valid accept cases', () => {
      const fired = new Set(cases.map((entry) => decodeValidationCase(entry)!.mutation));
      expect([...declaredClasses].sort().filter((name) => !fired.has(name))).toEqual([]);
      expect(fired).toContain('valid');
    });
  });
}
