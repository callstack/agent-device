import fc from 'fast-check';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  formatSelectorChainExpression,
  PROPERTY_RUNS,
  selectorChainArb,
} from '../__tests__/test-utils/index.ts';
import { parseSelectorChain } from './parse.ts';
import type { SelectorTerm } from './parse.ts';

function chainTerms(expression: string): SelectorTerm[][] {
  return parseSelectorChain(expression).selectors.map((selector) => selector.terms);
}

// Property, not another example: a selector value carries user text, so the
// grammar has to survive both quote characters, backslash runs, `||` and `=`
// inside a value, and whitespace-only values. Extend the hazard vocabulary in
// src/__tests__/test-utils/property-arbitraries.ts rather than pinning one more
// case here.
test('parsing a printed selector chain yields the terms it was printed from', () => {
  fc.assert(
    fc.property(selectorChainArb, ({ selectors, expression }) => {
      assert.deepEqual(chainTerms(expression), selectors);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test('parse -> serialize -> parse is idempotent for every selector chain', () => {
  fc.assert(
    fc.property(selectorChainArb, ({ expression }) => {
      const terms = chainTerms(expression);
      const canonical = formatSelectorChainExpression(terms);
      assert.deepEqual(chainTerms(canonical), terms);
      assert.equal(formatSelectorChainExpression(chainTerms(canonical)), canonical);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});
