import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { isSelectorVisibleInNodes, scrollUntilCaptureRefusal } from './scroll-until-match.ts';

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

test('a capture with no tree at all is refused rather than read as an empty screen', async () => {
  assert.deepEqual(await scrollUntilCaptureRefusal({}), {
    reason: 'no-capture',
    detail: 'the capture returned no accessibility tree',
  });
  assert.deepEqual(await scrollUntilCaptureRefusal({ nodes: [] }), {
    reason: 'no-capture',
    detail: 'the capture returned an empty accessibility tree',
  });
});

test('a backend sparse verdict is refused and carries the backend reason', async () => {
  assert.deepEqual(
    await scrollUntilCaptureRefusal({
      nodes: tree({ ref: 'e2', label: 'Submit', y: 200 }),
      snapshotQuality: { state: 'sparse', backend: 'tree', reason: 'AX bridge unavailable' },
    }),
    { reason: 'sparse-tree', detail: 'AX bridge unavailable' },
  );
});

test('the legacy iOS application-root-only shape is refused', async () => {
  assert.deepEqual(
    await scrollUntilCaptureRefusal({
      backend: 'xctest',
      nodes: [{ index: 0, ref: 'e1', type: 'Application', rect: VIEWPORT } as SnapshotNode],
    }),
    { reason: 'sparse-tree', detail: 'the capture exposed only the application root' },
  );
});

/**
 * Truncation is a readable tree missing its tail, not a failed read. Refusing it would fail large
 * screens where the target is plainly in view.
 */
test('a truncated but populated capture is not refused', async () => {
  assert.equal(
    await scrollUntilCaptureRefusal({
      nodes: tree({ ref: 'e2', label: 'Submit', y: 200 }),
      snapshotQuality: { state: 'ok', backend: 'tree' },
    }),
    undefined,
  );
});
