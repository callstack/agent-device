import fc from 'fast-check';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  formatSelectorChainExpression,
  PROPERTY_RUNS,
  selectorChainArb,
} from './__tests__/property-arbitraries.ts';
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

test('parseSelectorChain parses fallback and boolean terms', () => {
  const chain = parseSelectorChain('id=auth_continue || role=button label="Continue" visible=true');
  assert.equal(chain.selectors.length, 2);
  assert.equal(chain.selectors[0]!.terms[0]!.key, 'id');
  assert.equal(chain.selectors[1]!.terms[2]!.key, 'visible');
});

test('parseSelectorChain rejects unknown keys and malformed quotes', () => {
  assert.throws(() => parseSelectorChain('foo=bar'), /Unknown selector key/i);
  assert.throws(() => parseSelectorChain('label="unclosed'), /Unclosed quote/i);
  assert.throws(() => parseSelectorChain(''), /cannot be empty/i);
});

test('parseSelectorChain handles quoted values ending in escaped backslashes', () => {
  const chain = parseSelectorChain('label="path\\\\" || id=auth_continue');
  assert.equal(chain.selectors.length, 2);
  assert.equal(chain.selectors[0]!.terms[0]!.value, 'path\\');
});

test('parseSelectorChain decodes escaped selector string values', () => {
  const chain = parseSelectorChain(
    [
      'label="Switch\\nMy Community"',
      'value="A\\tB\\rC\\bD\\fE\\/F"',
      'id="item_\\u0031\\uD83D\\uDE00"',
      "text='It\\'s OK'",
    ].join(' '),
  );

  assert.equal(chain.selectors[0]!.terms[0]!.value, 'Switch\nMy Community');
  assert.equal(chain.selectors[0]!.terms[1]!.value, 'A\tB\rC\bD\fE/F');
  assert.equal(chain.selectors[0]!.terms[2]!.value, `item_1${String.fromCodePoint(0x1f600)}`);
  assert.equal(chain.selectors[0]!.terms[3]!.value, "It's OK");
});

test('parseSelectorChain preserves malformed and unknown selector string escapes', () => {
  const chain = parseSelectorChain('label="bad\\u12" value="keep\\q"');

  assert.equal(chain.selectors[0]!.terms[0]!.value, 'bad\\u12');
  assert.equal(chain.selectors[0]!.terms[1]!.value, 'keep\\q');
});

test('parseSelectorChain preserves literal escaped control sequences when double escaped', () => {
  const chain = parseSelectorChain('label="foo\\\\nbar"');

  assert.equal(chain.selectors[0]!.terms[0]!.value, 'foo\\nbar');
});
