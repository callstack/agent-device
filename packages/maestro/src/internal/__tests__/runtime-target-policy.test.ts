import { expect, test } from 'vitest';
import {
  filterVisibleMaestroMatches,
  matchesMaestroTypedSelector,
} from '../runtime-target-policy.ts';
import type { MaestroSelector } from '../program-ir.ts';
import { makeSnapshot } from './runtime-target-fixtures.ts';

function observeTreeTraversals<T>(values: T[]): {
  observed: T[];
  calls: Record<'flatMap' | 'map', number>;
} {
  const calls = { flatMap: 0, map: 0 };
  return {
    observed: new Proxy(values, {
      get(target, property, receiver) {
        if (property !== 'flatMap' && property !== 'map') {
          return Reflect.get(target, property, receiver);
        }
        return (...args: unknown[]) => {
          calls[property] += 1;
          return Reflect.apply(Reflect.get(target, property, receiver), receiver, args);
        };
      },
    }),
    calls,
  };
}

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

test('typed Maestro id and text selectors keep their primary field semantics', () => {
  const node = makeSnapshot([
    {
      index: 1,
      identifier: 'checkout-submit',
      label: 'Submit order',
      value: 'Submit order',
    },
  ]).nodes[0]!;

  expect(matchesMaestroTypedSelector(node, { id: 'checkout-submit' })).toBe(true);
  expect(matchesMaestroTypedSelector(node, { text: 'Submit' })).toBe(false);
  expect(matchesMaestroTypedSelector(node, { text: '^Submit.*' })).toBe(true);
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

test('the node-only matcher rejects full selectors at the type boundary', () => {
  const node = makeSnapshot([{ index: 1, label: 'Save' }]).nodes[0]!;
  const recursiveSelector: MaestroSelector = { text: 'Save', childOf: { id: 'card' } };

  void (() => {
    // @ts-expect-error Recursive selectors require snapshot-aware resolution.
    matchesMaestroTypedSelector(node, recursiveSelector);
  });
  expect(node.label).toBe('Save');
});

test('one match-filtering operation builds one canonical visibility context for all candidates', () => {
  const snapshot = makeSnapshot([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'StaticText',
      identifier: 'candidate',
      rect: { x: 20, y: 100, width: 100, height: 40 },
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'StaticText',
      identifier: 'candidate',
      rect: { x: 20, y: 200, width: 100, height: 40 },
    },
  ]);
  const traversals = observeTreeTraversals(snapshot.nodes);

  expect(
    filterVisibleMaestroMatches({
      nodes: traversals.observed,
      matches: traversals.observed.slice(1),
      platform: 'ios',
    }).map((node) => node.index),
  ).toEqual([1, 2]);
  expect(traversals.calls).toEqual({ flatMap: 1, map: 1 });
});
