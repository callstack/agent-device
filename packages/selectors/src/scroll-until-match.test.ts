import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { isSelectorVisibleInNodes } from './scroll-until-match.ts';

const VIEWPORT = { x: 0, y: 0, width: 400, height: 800 };

function tree(...rows: { ref: string; label: string; y: number }[]): SnapshotNode[] {
  return [
    { index: 0, ref: 'e1', type: 'Application', rect: VIEWPORT } as SnapshotNode,
    ...rows.map(
      (row, offset) =>
        ({
          index: offset + 1,
          parentIndex: 0,
          ref: row.ref,
          type: 'Button',
          label: row.label,
          rect: { x: 0, y: row.y, width: 400, height: 40 },
        }) as SnapshotNode,
    ),
  ];
}

test('a match inside the viewport is visible', async () => {
  assert.equal(
    await isSelectorVisibleInNodes({
      nodes: tree({ ref: 'e2', label: 'Submit', y: 200 }),
      selector: 'label=Submit',
      platform: 'ios',
    }),
    true,
  );
});

test('a match scrolled below the fold is present but not visible', async () => {
  assert.equal(
    await isSelectorVisibleInNodes({
      nodes: tree({ ref: 'e2', label: 'Submit', y: 2400 }),
      selector: 'label=Submit',
      platform: 'ios',
    }),
    false,
  );
});

test('a selector matching nothing is not visible', async () => {
  assert.equal(
    await isSelectorVisibleInNodes({
      nodes: tree({ ref: 'e2', label: 'Submit', y: 200 }),
      selector: 'label=Missing',
      platform: 'ios',
    }),
    false,
  );
});

test('an empty capture is not a match', async () => {
  assert.equal(
    await isSelectorVisibleInNodes({ nodes: [], selector: 'label=Submit', platform: 'ios' }),
    false,
  );
});

/**
 * The reason the predicate asks "some match", not "the first match": a list can hold rows that
 * share a selector, and the one above the fold must not end a scroll that has not yet reached the
 * row the caller can act on.
 */
test('an off-screen twin does not satisfy a selector whose other match is on screen', async () => {
  assert.equal(
    await isSelectorVisibleInNodes({
      nodes: tree({ ref: 'e2', label: 'Row', y: -900 }, { ref: 'e3', label: 'Row', y: 300 }),
      selector: 'label=Row',
      platform: 'ios',
    }),
    true,
  );
  assert.equal(
    await isSelectorVisibleInNodes({
      nodes: tree({ ref: 'e2', label: 'Row', y: -900 }, { ref: 'e3', label: 'Row', y: 3000 }),
      selector: 'label=Row',
      platform: 'ios',
    }),
    false,
  );
});
