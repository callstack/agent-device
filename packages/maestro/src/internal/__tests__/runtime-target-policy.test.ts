import { expect, test } from 'vitest';
import { matchesMaestroTypedSelector } from '../runtime-target-policy.ts';
import { makeSnapshot } from './runtime-target-fixtures.ts';

test('typed Maestro text selectors match visible text and state without expression strings', () => {
  const node = makeSnapshot([
    {
      index: 1,
      type: 'TextView',
      value: 'Subtotal: $42.10',
      enabled: true,
      selected: true,
    },
  ]).nodes[0]!;

  expect(
    matchesMaestroTypedSelector(node, { text: '^Subtotal.*', enabled: true, selected: true }),
  ).toBe(true);
  expect(matchesMaestroTypedSelector(node, { text: 'Subtotal', selected: false })).toBe(false);
});

test('typed Maestro id and label selectors keep their primary field semantics', () => {
  const node = makeSnapshot([
    {
      index: 1,
      identifier: 'checkout-submit',
      label: 'Submit order',
      value: 'Submit order',
    },
  ]).nodes[0]!;

  expect(matchesMaestroTypedSelector(node, { id: 'checkout-submit' })).toBe(true);
  expect(matchesMaestroTypedSelector(node, { label: 'Submit' })).toBe(false);
  expect(matchesMaestroTypedSelector(node, { label: '^Submit.*' })).toBe(true);
});

test('intersects every field in a compound Maestro selector', () => {
  const node = makeSnapshot([
    {
      index: 1,
      identifier: 'checkout-submit',
      label: 'Submit order',
      value: 'Submit order',
      enabled: true,
    },
  ]).nodes[0]!;

  expect(
    matchesMaestroTypedSelector(node, {
      id: 'checkout-submit',
      text: 'Submit order',
      label: '^Submit.*',
      enabled: true,
    }),
  ).toBe(true);
  expect(matchesMaestroTypedSelector(node, { id: 'checkout-submit', text: 'Cancel order' })).toBe(
    false,
  );
});

test('treats selector values as full Maestro regex without punctuation inference', () => {
  const node = makeSnapshot([
    {
      index: 1,
      type: 'TextView',
      label: 'Item 22 [ready',
    },
  ]).nodes[0]!;

  expect(matchesMaestroTypedSelector(node, { text: 'item \\d{2} \\[ready' })).toBe(true);
  expect(matchesMaestroTypedSelector(node, { text: 'Item 2' })).toBe(false);
  expect(matchesMaestroTypedSelector(node, { text: 'Item 22 [ready' })).toBe(true);
});
