import assert from 'node:assert/strict';
import { test } from 'vitest';
import { elementSettingsNodes } from '../../../snapshot/ios-scroll-visibility.fixtures.ts';
import { presentIosInteractiveSnapshot } from './index.ts';

test('presents one visible Element scroll surface across iOS capture backends', () => {
  const presented = presentIosInteractiveSnapshot(elementSettingsNodes(), 'private-ax');

  assert.deepEqual(
    presented.flatMap((node) => (node.label ? [node.label] : [])),
    [
      'Element',
      'Visible table heading',
      'Pinned flattened heading',
      'Visible row',
      'Partially clipped row',
      'Visible clipped child',
      'Visible co-located label',
      'Visible co-located value',
    ],
  );
  assert.equal(presented.find((node) => node.type === 'Table')?.hiddenContentBelow, true);
});

test('reprojects private-ax visibility after semantic rules tighten a scroll viewport', () => {
  const edge = { x: 0, y: 100, width: 120, height: 20 };
  const presented = presentIosInteractiveSnapshot(
    [
      { index: 0, depth: 0, type: 'Application' },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Table',
        rect: { x: 0, y: 100, width: 300, height: 500 },
      },
      { index: 2, depth: 2, parentIndex: 1, type: 'Cell', label: 'Visible', rect: edge },
      {
        index: 3,
        depth: 2,
        parentIndex: 1,
        type: 'Other',
        label: 'Vertical scroll bar, 2 pages',
        value: '0%',
        rect: { x: 296, y: 100, width: 4, height: 400 },
      },
      {
        index: 4,
        depth: 2,
        parentIndex: 1,
        type: 'Cell',
        label: 'Hidden precursor',
        rect: { x: 0, y: 550, width: 300, height: 40 },
      },
      ...Array.from({ length: 4 }, (_, offset) => ({
        index: offset + 5,
        depth: 3,
        parentIndex: 1,
        type: 'StaticText',
        label: `Collapsed ${offset + 1}`,
        rect: edge,
      })),
    ],
    'private-ax',
  );

  assert.deepEqual(
    presented.flatMap((node) => (node.label ? [node.label] : [])),
    ['Visible'],
  );
});

test('a bottomed scroll indicator preserves viewport-derived hidden content below', () => {
  const presented = presentIosInteractiveSnapshot([
    { index: 0, depth: 0, type: 'Application' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Table',
      rect: { x: 0, y: 100, width: 300, height: 400 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Offscreen',
      rect: { x: 0, y: 700, width: 300, height: 40 },
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Vertical scroll bar, 2 pages',
      value: '100%',
      rect: { x: 296, y: 100, width: 4, height: 350 },
    },
  ]);

  assert.equal(presented.find((node) => node.type === 'Table')?.hiddenContentBelow, true);
});
