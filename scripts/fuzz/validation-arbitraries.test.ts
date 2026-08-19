// The validation generator lookup (#1781 B2).

import { describe, expect, it } from 'vitest';
import { validationArbitraryFor } from './validation-arbitraries.ts';

describe('validationArbitraryFor', () => {
  it('resolves a generator for each validation target', () => {
    expect(validationArbitraryFor('cli-validation')).toBeDefined();
    expect(validationArbitraryFor('maestro-validation')).toBeDefined();
  });

  // `undefined` is what routes a classic target back to the hazard-splicing mutator, so this is
  // the difference between a corrupted-string case and an expectation-carrying one.
  it('returns undefined for the classic targets', () => {
    expect(validationArbitraryFor('selector')).toBeUndefined();
    expect(validationArbitraryFor('cli-args')).toBeUndefined();
  });
});
