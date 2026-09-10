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

/**
 * The verdict arrives under two spellings: `SnapshotState` says `snapshotQuality`, a
 * `BackendSnapshotResult` says `quality`. Reading only one is how a real backend sparse verdict
 * slipped through the first version of this check.
 */
test('a sparse verdict is refused under either spelling the capture can carry it in', async () => {
  const nodes = tree({ ref: 'e2', label: 'Submit', y: 200 });
  const sparse = { state: 'sparse', backend: 'tree', reason: 'AX bridge unavailable' } as const;
  const expected = { reason: 'sparse-tree', detail: 'AX bridge unavailable' };

  assert.deepEqual(await scrollUntilCaptureRefusal({ nodes, snapshotQuality: sparse }), expected);
  // The backend result's own spelling.
  assert.deepEqual(await scrollUntilCaptureRefusal({ nodes, quality: sparse }), expected);
  // A backend result whose verdict sits above the nested state it also carries.
  assert.deepEqual(
    await scrollUntilCaptureRefusal({ quality: sparse, snapshot: { nodes } }),
    expected,
  );
  // A nested state carrying its own verdict.
  assert.deepEqual(
    await scrollUntilCaptureRefusal({ snapshot: { nodes, snapshotQuality: sparse } }),
    expected,
  );
});

test('a malformed quality payload is not mistaken for a verdict', async () => {
  assert.equal(
    await scrollUntilCaptureRefusal({
      nodes: tree({ ref: 'e2', label: 'Submit', y: 200 }),
      quality: { state: 'not-a-state' },
    }),
    undefined,
  );
});

test('a nested snapshot supplies the nodes when the top level has none', async () => {
  assert.equal(
    await scrollUntilCaptureRefusal({
      snapshot: { nodes: tree({ ref: 'e2', label: 'X', y: 10 }) },
    }),
    undefined,
  );
  assert.deepEqual(await scrollUntilCaptureRefusal({ snapshot: { nodes: [] } }), {
    reason: 'no-capture',
    detail: 'the capture returned an empty accessibility tree',
  });
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
 * A tree the backend vouches for is readable, and so is one whose tail was truncated: truncation
 * drops content, it does not make the capture untrustworthy. Refusing either would fail large
 * screens where the target is plainly in view.
 */
test('a populated capture is not refused, healthy or recovered', async () => {
  const nodes = tree({ ref: 'e2', label: 'Submit', y: 200 });
  assert.equal(
    await scrollUntilCaptureRefusal({
      nodes,
      snapshotQuality: { state: 'healthy', backend: 'tree' },
    }),
    undefined,
  );
  assert.equal(
    await scrollUntilCaptureRefusal({
      nodes,
      snapshotQuality: { state: 'recovered', backend: 'tree' },
    }),
    undefined,
  );
  assert.equal(await scrollUntilCaptureRefusal({ nodes }), undefined);
});
