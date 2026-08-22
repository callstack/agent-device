/**
 * #1800: a positional list shaped like a selector (a recognized key, or an
 * unrecognized `key=value`) must never silently degrade to a `text` wait —
 * that degradation is exactly the shape that reads as "element absent" after
 * a full timeout instead of the caller's own argument mistake. See #1035 for
 * the sibling fix on click/press/fill/get.
 */
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { test } from 'vitest';
import { isValidSelectorExpression, SELECTOR_KEY_NAMES } from '@agent-device/selectors';
import { PROPERTY_RUNS } from '../__tests__/test-utils/property-arbitraries.ts';
import { parseWaitPositionals, resolveWaitBudgetMs } from './wait-positionals.ts';

function assertInvalid(args: string[], messageFragment: string) {
  const result = parseWaitPositionals(args);
  assert.ok(result, `expected a result for ${JSON.stringify(args)}`);
  assert.equal(result.kind, 'invalid');
  if (result.kind !== 'invalid') return;
  assert.ok(
    result.message.includes(messageFragment),
    `expected message to include ${JSON.stringify(messageFragment)}, got ${JSON.stringify(result.message)}`,
  );
}

// --- the issue's reproduction shapes -----------------------------------

test('a condition word followed by a selector-shaped value is rejected, not read as text (#1800 repro)', () => {
  const result = parseWaitPositionals(['open', 'label="Open"', '25000']);
  assert.ok(result);
  assert.notEqual(result.kind, 'text');
  assertInvalid(['open', 'label="Open"', '25000'], 'label="Open"');
});

test('"exists" followed by a selector-shaped value is rejected and points at the selector form', () => {
  assertInvalid(['exists', 'label="x"', '100'], "wait 'visible");
});

test('unknown selector key is rejected with the supported-key list, not read as text', () => {
  const result = parseWaitPositionals(['lbl="x"', '100']);
  assert.ok(result);
  assert.equal(result.kind, 'invalid');
  if (result.kind !== 'invalid') return;
  assert.equal(result.reason, 'unknown-selector-key');
  assert.ok(result.message.includes('lbl'));
  assert.ok(result.message.includes('label='));
});

// --- still-valid selector forms are untouched ---------------------------

test('a valid selector still parses as selector', () => {
  const result = parseWaitPositionals(['label="Open"', '5000']);
  assert.deepEqual(result, {
    kind: 'selector',
    selectorExpression: 'label="Open"',
    timeoutMs: 5000,
  });
});

test('"visible" leading a valid selector still parses as selector (boolean key, not a condition word)', () => {
  const result = parseWaitPositionals(['visible', 'label="Open"', '25000']);
  assert.deepEqual(result, {
    kind: 'selector',
    selectorExpression: 'visible label="Open"',
    timeoutMs: 25000,
  });
});

// --- trailing tokens after a valid selector prefix are rejected too -----

test('a valid selector prefix followed by an unquoted extra word is rejected, not merged into text', () => {
  assertInvalid(['label="Open"', 'foo', '5000'], 'extra arguments');
});

// --- bare text keeps working ---------------------------------------------

test('bare single-word text still parses as text', () => {
  const result = parseWaitPositionals(['Continue', '1500']);
  assert.deepEqual(result, { kind: 'text', text: 'Continue', timeoutMs: 1500 });
});

test('bare multi-word text still parses as text', () => {
  const result = parseWaitPositionals(['Sign', 'in', '2000']);
  assert.deepEqual(result, { kind: 'text', text: 'Sign in', timeoutMs: 2000 });
});

test('explicit "text" keyword form bypasses selector-shape rejection entirely', () => {
  // Even though "label=Open" is selector-shaped, the explicit `text` keyword is the caller's
  // unambiguous escape hatch and must always win.
  const result = parseWaitPositionals(['text', 'label=Open', '5000']);
  assert.deepEqual(result, { kind: 'text', text: 'label=Open', timeoutMs: 5000 });
});

test('free prose containing a bare "=" with no key stays literal text', () => {
  const result = parseWaitPositionals(['Total', '=', '5', '3000']);
  assert.deepEqual(result, { kind: 'text', text: 'Total = 5', timeoutMs: 3000 });
});

// --- documented boundary: a bare selector-key word alone is rejected, not text ---

test('a single word that IS a recognized selector key is rejected rather than read as literal text', () => {
  // "id" alone cannot become a valid selector (it needs a value), but it also must not silently
  // become literal wait text — an agent that meant the word "id" has to say so via `wait text`.
  assertInvalid(['id', '3000'], "wait text 'id'");
});

// --- resolveWaitBudgetMs stays sane for the new variant -------------------

test('resolveWaitBudgetMs returns null for a rejected selector-shaped positional list', () => {
  assert.equal(resolveWaitBudgetMs(['open', 'label="Open"', '25000']), null);
});

// --- properties over examples ---------------------------------------------

const TEXT_SELECTOR_KEYS = SELECTOR_KEY_NAMES.filter((key) => !isValidSelectorExpression(key));
const BOOLEAN_SELECTOR_KEYS = SELECTOR_KEY_NAMES.filter((key) => isValidSelectorExpression(key));

const selectorValueArb = fc.oneof(
  fc.constantFrom('Open', 'Sign in', "it's", 'a || b', 'key=value'),
  fc.string({ minLength: 1, maxLength: 8 }).filter((value) => value.trim().length > 0),
);

/** One token of a generated, guaranteed-valid selector expression. */
const selectorTokenArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .record({ key: fc.constantFrom(...TEXT_SELECTOR_KEYS), value: selectorValueArb })
    .map(({ key, value }) => `${key}=${JSON.stringify(value)}`),
  fc.constantFrom(...BOOLEAN_SELECTOR_KEYS),
);

const validSelectorTokensArb: fc.Arbitrary<string[]> = fc.array(selectorTokenArb, {
  minLength: 1,
  maxLength: 3,
});

test('property: a generated valid selector expression never parses as text or invalid', () => {
  fc.assert(
    fc.property(validSelectorTokensArb, (tokens) => {
      const result = parseWaitPositionals(tokens);
      assert.ok(result);
      assert.equal(result.kind, 'selector');
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

const plainWordArb = fc
  .string({ minLength: 1, maxLength: 6 })
  .filter(
    (token) =>
      token.trim().length > 0 &&
      !token.includes('=') &&
      !token.startsWith('@') &&
      token !== 'text' &&
      token !== 'stable' &&
      Number.isNaN(Number(token)),
  );

const recognizedKeyValueTokenArb: fc.Arbitrary<string> = fc
  .record({ key: fc.constantFrom(...SELECTOR_KEY_NAMES), value: selectorValueArb })
  .map(({ key, value }) => `${key}=${JSON.stringify(value)}`);

const unrecognizedKeyValueTokenArb: fc.Arbitrary<string> = fc
  .record({
    key: fc
      .string({ minLength: 1, maxLength: 8 })
      .filter(
        (key) =>
          /^[a-zA-Z][a-zA-Z0-9]*$/.test(key) &&
          !SELECTOR_KEY_NAMES.includes(key.toLowerCase() as (typeof SELECTOR_KEY_NAMES)[number]),
      ),
    value: selectorValueArb,
  })
  .map(({ key, value }) => `${key}=${JSON.stringify(value)}`);

const keyValueShapedTokenArb = fc.oneof(recognizedKeyValueTokenArb, unrecognizedKeyValueTokenArb);

test('property: any positional list containing a key=value-shaped token never parses as text', () => {
  fc.assert(
    fc.property(
      fc.array(plainWordArb, { maxLength: 3 }),
      keyValueShapedTokenArb,
      fc.nat({ max: 3 }),
      (plainTokens, kvToken, insertAtRaw) => {
        const insertAt = Math.min(insertAtRaw, plainTokens.length);
        const tokens = [...plainTokens.slice(0, insertAt), kvToken, ...plainTokens.slice(insertAt)];
        const result = parseWaitPositionals(tokens);
        assert.ok(result);
        assert.notEqual(result.kind, 'text');
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});
