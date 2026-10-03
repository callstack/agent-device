import { expect, test } from 'vitest';
import { resolveTypedMaestroTarget } from '../daemon-runtime-port-observation.ts';
import { makeSnapshot } from './daemon-runtime-port-fixtures.ts';

test('nested positional relations never use atomic iOS selector dispatch', () => {
  const snapshot = makeSnapshot([
    {
      index: 0,
      type: 'StaticText',
      identifier: 'header',
      rect: { x: 20, y: 20, width: 100, height: 30 },
    },
    {
      index: 1,
      type: 'Other',
      identifier: 'card',
      rect: { x: 20, y: 100, width: 300, height: 180 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'TextField',
      identifier: 'field',
      rect: { x: 40, y: 160, width: 180, height: 40 },
    },
  ]);

  const result = resolveTypedMaestroTarget({
    snapshot,
    platform: 'ios',
    context: { generation: 0, env: {} },
    query: {
      selector: { id: 'field', childOf: { id: 'card', below: { id: 'header' } } },
      purpose: 'tap',
      timeoutMs: 0,
      allowAtomicSelectorDispatch: true,
    },
  });

  expect(result).toMatchObject({ matched: true, visible: true, candidateCount: 1 });
  expect(result).not.toHaveProperty('dispatchSelector');
});

test('an empty recursive relation also opts out of atomic iOS dispatch', () => {
  const snapshot = makeSnapshot([
    {
      index: 0,
      type: 'TextField',
      identifier: 'field',
      rect: { x: 40, y: 160, width: 180, height: 40 },
    },
  ]);

  const result = resolveTypedMaestroTarget({
    snapshot,
    platform: 'ios',
    context: { generation: 0, env: {} },
    query: {
      selector: { id: 'field', containsDescendants: [] },
      purpose: 'tap',
      timeoutMs: 0,
      allowAtomicSelectorDispatch: true,
    },
  });

  expect(result).toMatchObject({ matched: true, visible: true, candidateCount: 1 });
  expect(result).not.toHaveProperty('dispatchSelector');
});
