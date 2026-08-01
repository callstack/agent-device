import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { annotateCoveredSnapshotNodes } from '../snapshot-occlusion.ts';

// #1478 P5 codec-extraction regression: `annotateCoveredSnapshotNodes` marks
// a touch candidate `interactionBlocked: 'covered'` when a later, floating
// piece of UI chrome (toolbar/dialog/menu/... or a caller-supplied
// `isAdditionalOverlayNode` match, e.g. an Android IME keyboard key) sits on
// top of it. `findCoveringNode` asks, for a candidate cover, "is THAT
// candidate itself covered by something later" — a real question (a
// keyboard row can itself be behind another overlay) — via a recursive call
// into the same function.
//
// Without memoization that recursive question gets re-asked from scratch on
// every path that reaches it: checking whether position P is covered
// requires checking every later position, and checking EACH of those
// requires (independently) checking every position after IT, and so on —
// O(2^overlayPositions.length) work with no upper bound on wall-clock time.
// A live m6 repro (`fill` targeting the second field of a two-field Android
// form) hit this with ~39 keyboard-key nodes classified as
// `isAdditionalOverlayNode` and pegged the daemon at ~99% CPU indefinitely
// (`ps` showed no return; a live `sample`/CDP pause always landed inside
// this exact recursive triad). The fix caches `findCoveringNode`'s answer
// per position for the lifetime of one `annotateCoveredSnapshotNodes` call
// (the scan's own node list never changes mid-pass, so the answer for a
// given position is provably stable across every path that asks — see the
// doc comment on `OcclusionScan.coverCache`), making each position resolve
// at most once.
//
// This test builds a similarly-shaped worst case: many same-kind
// overlay-classified nodes with distinct, mutually non-overlapping rects, so
// every recursive descent is genuinely exercised (nothing short-circuits on
// an early rect-equality or point-containment match) without depending on a
// real device. Before the fix this synchronous call does not return within
// the suite's per-test timeout; after the fix it returns in well under it.

function keyboardKeyNode(index: number, column: number, row: number): RawSnapshotNode {
  return {
    index,
    type: 'key',
    role: 'menu', // matches OVERLAY_KIND_FRAGMENTS, so isOverlayLikeNode is true without a callback
    hittable: true,
    label: `key-${index}`,
    rect: { x: column * 40, y: 400 + row * 40, width: 36, height: 36 },
  };
}

test('annotateCoveredSnapshotNodes resolves a large mutually-overlapping overlay set without exponential blowup', () => {
  // 4 rows x 10 columns = 40 candidate "keyboard key" nodes, matching the
  // scale that wedged the daemon live (~39 IME-classified nodes).
  const nodes: RawSnapshotNode[] = [];
  let index = 0;
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 10; column += 1) {
      nodes.push(keyboardKeyNode(index, column, row));
      index += 1;
    }
  }

  const startedAt = Date.now();
  const result = annotateCoveredSnapshotNodes(nodes);
  const elapsedMs = Date.now() - startedAt;

  // Generous relative to the sub-millisecond cost memoization gives this
  // input; a regression back to the unmemoized O(2^40) shape would instead
  // fail the suite's own test timeout, never reach this assertion at all.
  assert.ok(
    elapsedMs < 1000,
    `expected annotateCoveredSnapshotNodes to resolve 40 mutually-overlapping overlay nodes quickly, took ${elapsedMs}ms`,
  );
  assert.equal(result.length, nodes.length);
});

test('annotateCoveredSnapshotNodes still marks a touch target covered by a later overlay', () => {
  const target: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Save',
    rect: { x: 10, y: 10, width: 100, height: 40 },
  };
  const overlay: RawSnapshotNode = {
    index: 1,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 200, height: 200 },
  };

  const result = annotateCoveredSnapshotNodes([target, overlay]);
  assert.equal(result[0]?.interactionBlocked, 'covered');
  assert.equal(result[0]?.hittable, false);
});

test('annotateCoveredSnapshotNodes leaves an uncovered touch target unchanged', () => {
  const target: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Save',
    rect: { x: 10, y: 10, width: 100, height: 40 },
  };
  const farAwayOverlay: RawSnapshotNode = {
    index: 1,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 500, y: 500, width: 200, height: 200 },
  };

  const result = annotateCoveredSnapshotNodes([target, farAwayOverlay]);
  assert.equal(result[0]?.interactionBlocked, undefined);
  assert.equal(result[0]?.hittable, true);
});

test('cover decisions read only the immutable input: the input array and its nodes are never mutated', () => {
  const target: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Pay',
    rect: { x: 10, y: 10, width: 100, height: 40 },
  };
  const overlay: RawSnapshotNode = {
    index: 1,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 400, height: 400 },
  };
  const nodes = [target, overlay];
  const before = JSON.stringify(nodes);

  const annotated = annotateCoveredSnapshotNodes(nodes);

  assert.equal(JSON.stringify(nodes), before);
  assert.notEqual(annotated, nodes);
  assert.equal(annotated[0]?.interactionBlocked, 'covered');
  assert.equal(nodes[0]?.interactionBlocked, undefined);
});

test('a covered target still counts as covered by a live overlay above the chain', () => {
  // T sits under sheet A; dialog B covers A, which disqualifies A as a cover
  // for T (visibleCoverRect refuses covered candidates). T is still covered —
  // by B directly — and every one of those decisions reads the same immutable
  // input, so the outcome cannot depend on evaluation or annotation order.
  // A itself carries no label and is not hittable, so it is not a touch
  // candidate and is never annotated.
  const t: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Pay',
    rect: { x: 10, y: 10, width: 100, height: 40 },
  };
  const a: RawSnapshotNode = {
    index: 1,
    type: 'sheet',
    role: 'sheet',
    rect: { x: 0, y: 0, width: 200, height: 200 },
  };
  const b: RawSnapshotNode = {
    index: 2,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 400, height: 400 },
  };

  const annotated = annotateCoveredSnapshotNodes([t, a, b]);

  assert.equal(annotated[0]?.interactionBlocked, 'covered');
  assert.equal(annotated[1]?.interactionBlocked, undefined);
  assert.equal(annotated[2]?.interactionBlocked, undefined);
});

test('cover decisions ignore annotations even through a mutation-sensitive predicate and ancestor walk', () => {
  // P (a touch target) is covered by dialog D and gets annotated. Overlay O is
  // P's child and is classified through the caller predicate, whose ancestor
  // walk reads P: a predicate that (pathologically) also matches annotated
  // nodes would, against a mutable byIndex, see the annotated P as a
  // renderable overlay ancestor and declassify O mid-pass — flipping T's
  // outcome based on evaluation order. Decisions must read pristine input:
  // P never matches, O stays an overlay root, T is covered.
  const p: RawSnapshotNode = {
    index: 10,
    type: 'group',
    role: 'group',
    label: 'Parent',
    rect: { x: 0, y: 0, width: 50, height: 50 },
  };
  const t: RawSnapshotNode = {
    index: 11,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Pay',
    rect: { x: 100, y: 100, width: 80, height: 40 },
  };
  const o: RawSnapshotNode = {
    index: 12,
    parentIndex: 10,
    type: 'group',
    role: 'group',
    identifier: 'ov-root',
    rect: { x: 60, y: 60, width: 200, height: 200 },
  };
  const d: RawSnapshotNode = {
    index: 13,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 60, height: 60 },
  };

  const annotated = annotateCoveredSnapshotNodes([p, t, o, d], {
    isAdditionalOverlayNode: (node) =>
      node.identifier === 'ov-root' || node.interactionBlocked === 'covered',
  });

  assert.equal(annotated.find((n) => n.index === 10)?.interactionBlocked, 'covered');
  assert.equal(annotated.find((n) => n.index === 11)?.interactionBlocked, 'covered');
});
