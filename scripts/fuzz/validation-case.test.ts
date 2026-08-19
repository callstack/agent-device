// The validation case envelope and its judge (#1781 B2).
//
// The envelope is what carries a planted expectation from the generator to the judge, through the
// corpus, the artifact, and the worker boundary. A malformed one is a harness or corpus defect
// rather than a parser bug, but it must still surface red instead of crashing a nightly.

import { describe, expect, it } from 'vitest';
import { checkCase } from './invariant.ts';
import { getFuzzTarget } from './registry.ts';
import { decodeValidationCase, encodeValidationCase } from './validation-case.ts';

describe('validation case envelope', () => {
  it('round-trips a case through the string form the corpus and artifacts carry', () => {
    const original = {
      payload: ['open', 'com.example.app'],
      mutation: 'valid',
      expect: { outcome: 'accept' },
    } as const;
    expect(decodeValidationCase(encodeValidationCase(original))).toEqual(original);
  });

  it.each([
    ['not json at all', 'plain text'],
    ['valid json that is not an envelope', '{"nope":1}'],
    ['an envelope without an expectation', '{"payload":["open"],"mutation":"x"}'],
    [
      'a reject expectation without a code',
      '{"payload":[],"mutation":"x","expect":{"outcome":"reject"}}',
    ],
  ])('rejects %s', (_label, input) => {
    expect(decodeValidationCase(input)).toBeNull();
  });

  it('reports a malformed envelope as a finding instead of crashing the worker', () => {
    const failure = checkCase(getFuzzTarget('cli-validation'), 'not an envelope');
    expect(failure?.kind).toBe('untyped-throw');
    expect(failure?.detail).toContain('malformed validation case envelope');
  });
});
