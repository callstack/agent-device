import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { annotateCoveredSnapshotNodes } from './snapshot-occlusion.ts';

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

test('an empty or single-node snapshot is returned unchanged, by reference', () => {
  const empty: RawSnapshotNode[] = [];
  assert.equal(annotateCoveredSnapshotNodes(empty), empty);

  const solo: RawSnapshotNode[] = [
    {
      index: 0,
      type: 'button',
      role: 'button',
      hittable: true,
      label: 'Save',
      rect: { x: 0, y: 0, width: 50, height: 20 },
    },
  ];
  assert.equal(annotateCoveredSnapshotNodes(solo), solo);
});

test('when nothing is covered, the exact input array is returned (no defensive copy)', () => {
  // Two nodes (not one) so this actually reaches the "nothing in
  // coveredPositions" early return, rather than the separate nodes.length < 2
  // early return above it.
  const nodes: RawSnapshotNode[] = [
    {
      index: 0,
      type: 'button',
      role: 'button',
      hittable: true,
      label: 'Save',
      rect: { x: 0, y: 0, width: 50, height: 20 },
    },
    {
      index: 1,
      type: 'button',
      role: 'button',
      hittable: true,
      label: 'Cancel',
      rect: { x: 500, y: 500, width: 50, height: 20 },
    },
  ];
  assert.equal(annotateCoveredSnapshotNodes(nodes), nodes);
});

test('a node cannot be marked covered by its own descendant', () => {
  // Child C renders on top of (and geometrically covers) its own parent P — an
  // ordinary "content overlaps container" shape, not real occluding chrome. The
  // parent/child relation must disqualify C as a cover for P regardless of
  // z-order or rect overlap.
  const parent: RawSnapshotNode = {
    index: 0,
    type: 'container',
    role: 'group',
    label: 'Card',
    hittable: true,
    rect: { x: 10, y: 10, width: 100, height: 100 },
  };
  const child: RawSnapshotNode = {
    index: 1,
    parentIndex: 0,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 200, height: 200 },
  };

  const annotated = annotateCoveredSnapshotNodes([parent, child]);

  assert.equal(annotated[0]?.interactionBlocked, undefined);
});

test('a node cannot be marked covered by its own ancestor either, even when the ancestor is listed later', () => {
  // The relatedness check is symmetric: it must also catch the reverse
  // direction (candidate is target's ancestor), which the parent/descendant
  // case above cannot exercise on its own since only later-listed nodes are
  // ever considered as covers. Two levels deep (target -> intermediate ->
  // grandparent) so the walk must climb past the first parent, not just check
  // it directly.
  const target: RawSnapshotNode = {
    index: 0,
    parentIndex: 1,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Pay',
    rect: { x: 10, y: 10, width: 80, height: 40 },
  };
  const intermediate: RawSnapshotNode = {
    index: 1,
    parentIndex: 2,
    type: 'group',
    role: 'group',
    rect: { x: 0, y: 0, width: 300, height: 300 },
  };
  const grandparent: RawSnapshotNode = {
    index: 2,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 400, height: 400 },
  };

  const annotated = annotateCoveredSnapshotNodes([target, intermediate, grandparent]);

  assert.equal(annotated[0]?.interactionBlocked, undefined);
});

test('a later, non-overlay-classified node never covers a target, however it overlaps geometrically', () => {
  // B is a plain button, not floating UI chrome (no OVERLAY_KIND_FRAGMENTS
  // match, no isAdditionalOverlayNode match) — only genuine overlay-classified
  // nodes may ever act as covers. B's rect is deliberately NOT
  // approximately-equal to A's (a much bigger box that still contains A's
  // center point) so the separate rect-equality guard cannot also explain an
  // "uncovered" result — this test isolates the overlay-classification check.
  const a: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Under',
    rect: { x: 10, y: 10, width: 80, height: 40 },
  };
  const b: RawSnapshotNode = {
    index: 1,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Over',
    rect: { x: 0, y: 0, width: 400, height: 400 },
  };

  const annotated = annotateCoveredSnapshotNodes([a, b]);

  assert.equal(annotated[0]?.interactionBlocked, undefined);
});

test('an overlay candidate with a rect approximately equal to the target is never treated as covering it', () => {
  // Same rect, both otherwise legitimate: D is genuinely overlay-classified
  // and unrelated to T, so only the rect-equality guard can explain this
  // staying uncovered — isolates that check from the overlay-classification
  // check above.
  const target: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Save',
    rect: { x: 10, y: 10, width: 80, height: 40 },
  };
  const sameRectDialog: RawSnapshotNode = {
    index: 1,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 10, y: 10, width: 80, height: 40 },
  };

  const annotated = annotateCoveredSnapshotNodes([target, sameRectDialog]);

  assert.equal(annotated[0]?.interactionBlocked, undefined);
});

test('a node classified through the caller predicate is excluded as its own overlay root when a renderable ancestor is two levels up', () => {
  // Root R and leaf L both match the caller predicate; L's immediate parent M
  // does not. Without correctly walking past M to find R, L would wrongly
  // count as an independent overlay root alongside R — this test isolates
  // hasRenderableAdditionalOverlayAncestor's multi-level climb specifically
  // (the single-level case is already covered by the existing
  // "ignore annotations... ancestor walk" test above).
  const target: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Save',
    rect: { x: 500, y: 500, width: 80, height: 40 },
  };
  const root: RawSnapshotNode = {
    index: 1,
    identifier: 'overlay-root',
    type: 'group',
    role: 'group',
    rect: { x: 0, y: 0, width: 20, height: 20 },
  };
  const middle: RawSnapshotNode = {
    index: 2,
    parentIndex: 1,
    type: 'group',
    role: 'group',
    rect: { x: 0, y: 0, width: 20, height: 20 },
  };
  const leaf: RawSnapshotNode = {
    index: 3,
    parentIndex: 2,
    identifier: 'overlay-root',
    type: 'group',
    role: 'group',
    // Only the leaf's rect covers the target — if the leaf were wrongly kept
    // as an independent overlay root (ancestor climb stopped one level too
    // early at M), the target would be covered; if correctly excluded in
    // favor of the root-most classification, it stays uncovered.
    rect: { x: 480, y: 480, width: 200, height: 200 },
  };

  const annotated = annotateCoveredSnapshotNodes([target, root, middle, leaf], {
    isAdditionalOverlayNode: (node) => node.identifier === 'overlay-root',
  });

  assert.equal(annotated[0]?.interactionBlocked, undefined);
});

test('an overlay-kind node with no positive-area rect never covers anything, even a target dead center on its degenerate line', () => {
  // The target's center sits exactly on x=50, the zero-width dialog's only
  // x-coordinate — a generic "does the rect overlap" check could accidentally
  // treat this degenerate rect as containing that single point. Positioning
  // the target precisely there (rather than somewhere the rect trivially
  // misses) is what makes this test isolate the width>0 requirement, not
  // just "an empty rect happens not to overlap".
  const target: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Save',
    rect: { x: 30, y: 10, width: 40, height: 20 }, // center = (50, 20)
  };
  const zeroWidthDialog: RawSnapshotNode = {
    index: 1,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 50, y: 0, width: 0, height: 200 },
  };

  const annotated = annotateCoveredSnapshotNodes([target, zeroWidthDialog]);

  assert.equal(annotated[0]?.interactionBlocked, undefined);
});

test('an overlay-kind node with zero height never covers anything, even a target dead center on its degenerate line', () => {
  const target: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Save',
    rect: { x: 10, y: 30, width: 40, height: 20 }, // center = (30, 40)
  };
  const zeroHeightDialog: RawSnapshotNode = {
    index: 1,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 40, width: 200, height: 0 },
  };

  const annotated = annotateCoveredSnapshotNodes([target, zeroHeightDialog]);

  assert.equal(annotated[0]?.interactionBlocked, undefined);
});

test('a node classified as viewport root never covers, even if its kind text otherwise matches overlay fragments', () => {
  // type "application" + role "dialog" would match the 'dialog' overlay
  // fragment, but a window/application-level node is excluded outright — it
  // is the screen itself, never floating chrome on top of it.
  const target: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Save',
    rect: { x: 10, y: 10, width: 80, height: 40 },
  };
  const applicationRoot: RawSnapshotNode = {
    index: 1,
    type: 'application',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };

  const annotated = annotateCoveredSnapshotNodes([target, applicationRoot]);

  assert.equal(annotated[0]?.interactionBlocked, undefined);
});

test('a full-viewport toolbar container does not cover its application siblings', () => {
  const application: RawSnapshotNode = {
    index: 0,
    type: 'application',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };
  const target: RawSnapshotNode = {
    index: 1,
    type: 'button',
    role: 'button',
    parentIndex: 0,
    label: 'Drag source',
    rect: { x: 20, y: 100, width: 120, height: 50 },
  };
  const toolbarContainer: RawSnapshotNode = {
    index: 2,
    type: 'toolbar',
    parentIndex: 0,
    label: 'Toolbar',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };

  const annotated = annotateCoveredSnapshotNodes([application, target, toolbarContainer]);

  assert.equal(annotated[1]?.interactionBlocked, undefined);
});

// #2996: on iOS 26/27 UIKit hosts a bottom tab bar in a `_UIFloatingBarContainerView` (published as
// `type: 'Toolbar'`) that is a SIBLING of the tab screen's content branch under the same layout
// container, and sizes it to that branch's frame. The reporter's capture shows `0,0,402,791` beside a
// `0,0,402,791` content branch with the 83pt tab bar at y=791 outside both; the two "live shape"
// tests below carry the trees captured on an iPhone 18 Pro (iOS 27.0). The container reports
// `hittable: true` and passes touches through, so `press`/`fill` refused every element above the tab
// bar while a coordinate press at the same point worked.
//
// `isFullViewportChromeContainer` cannot reach this: it compares the candidate against the VIEWPORT
// root's rect, and the container deliberately stops short of it. The rule these tests pin is the
// sibling-level one — a chrome candidate whose frame equals the frame of the branch listed beside it
// is sharing that branch's footprint, not floating over part of it, so its own box is not covering
// evidence; the controls it really draws are descendants with their own smaller rects, which the scan
// still judges on their own.
test("a chrome container sized to its content sibling branch does not cover that branch's targets (#2996)", () => {
  // The bridge path publishes the UIKit class in `role` beside `type: 'Toolbar'`; the runner path
  // publishes the same container as a bare `Toolbar` with no class name. Neither may condemn the
  // content, and neither is the viewport-sized case the existing exemption already handles.
  const annotated = annotateCoveredSnapshotNodes([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      role: 'UIApplication',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      role: 'UIWindow',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      role: 'UILayoutContainerView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: 'Other',
      role: 'RCTRootContentView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 4,
      parentIndex: 3,
      depth: 4,
      type: 'Button',
      role: 'RCTButton',
      label: 'Add plant',
      rect: { x: 151, y: 74, width: 100, height: 32 },
      hittable: true,
    },
    {
      index: 5,
      parentIndex: 2,
      depth: 3,
      type: 'Toolbar',
      role: '_UIFloatingBarContainerView',
      label: 'Toolbar',
      // Exactly the content branch's frame — not the viewport's (874 tall), which is what the
      // existing full-viewport exemption keys on.
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
  ]);

  assert.equal(annotated[4]?.interactionBlocked, undefined);
  assert.equal(annotated[4]?.hittable, true);
});

test('the same content stays actionable when the container is published without a UIKit class name (#2996 runner shape)', () => {
  // Same tree, runner-shaped kinds: no `role`, so only `type: 'Toolbar'` identifies the candidate.
  const annotated = annotateCoveredSnapshotNodes([
    { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: 'Other',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 4,
      parentIndex: 3,
      depth: 4,
      type: 'Button',
      label: 'Add plant',
      rect: { x: 151, y: 74, width: 100, height: 32 },
      hittable: true,
    },
    {
      index: 5,
      parentIndex: 2,
      depth: 3,
      type: 'Toolbar',
      label: 'Toolbar',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
  ]);

  assert.equal(annotated[4]?.interactionBlocked, undefined);
});

test('a control the exempt container really hosts still covers what it overlaps (#2996)', () => {
  // The exemption excuses the container's OWN box, not its subtree. The floating button the
  // container hosts has its own smaller rect, is unrelated to the target, and differs from the
  // branch frame, so it keeps covering the content beneath it — the fix cannot trade false
  // refusals for missed real occlusion.
  const annotated = annotateCoveredSnapshotNodes([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      role: 'UIApplication',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      role: 'UIWindow',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      role: 'UILayoutContainerView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: 'Other',
      role: 'RCTRootContentView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 4,
      parentIndex: 3,
      depth: 4,
      type: 'Button',
      role: 'RCTButton',
      label: 'Add plant',
      rect: { x: 151, y: 700, width: 100, height: 32 },
      hittable: true,
    },
    {
      index: 5,
      parentIndex: 2,
      depth: 3,
      type: 'Toolbar',
      role: '_UIFloatingBarContainerView',
      label: 'Toolbar',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 6,
      parentIndex: 5,
      depth: 4,
      type: 'Toolbar',
      role: '_UIBarPlatterView',
      label: 'Add',
      rect: { x: 140, y: 690, width: 120, height: 50 },
      hittable: true,
    },
  ]);

  assert.equal(annotated[4]?.interactionBlocked, 'covered');
  assert.equal(annotated[5]?.interactionBlocked, undefined);
});

test('a chrome candidate whose frame differs from the content branch beside it still covers (#2996 non-vacuity)', () => {
  // Isolates the frame-EQUALITY requirement from mere overlap: the container is 60pt shorter than
  // its content branch, so it matches neither the branch nor the viewport, and its box is real
  // covering evidence over the target in the region they share.
  const annotated = annotateCoveredSnapshotNodes([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      role: 'UIApplication',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      role: 'UIWindow',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      role: 'UILayoutContainerView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: 'Other',
      role: 'RCTRootContentView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 4,
      parentIndex: 3,
      depth: 4,
      type: 'Button',
      role: 'RCTButton',
      label: 'Add plant',
      rect: { x: 151, y: 74, width: 100, height: 32 },
      hittable: true,
    },
    {
      index: 5,
      parentIndex: 2,
      depth: 3,
      type: 'Toolbar',
      role: '_UIFloatingBarContainerView',
      label: 'Toolbar',
      rect: { x: 0, y: 0, width: 402, height: 731 },
      hittable: true,
    },
  ]);

  assert.equal(annotated[4]?.interactionBlocked, 'covered');
});

test('a chrome candidate taller than the content branch beside it still covers, so equality is not overlap (#2996 containment)', () => {
  // The mirror must be the SAME frame, not merely overlapping or containing it. Here the container
  // reaches 91pt below the content branch while still stopping short of the viewport, so it really
  // does paint over the branch's lower edge and keeps covering the target inside it.
  const annotated = annotateCoveredSnapshotNodes([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      role: 'UIApplication',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      role: 'UIWindow',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      role: 'UILayoutContainerView',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: 'Other',
      role: 'RCTRootContentView',
      rect: { x: 0, y: 0, width: 402, height: 700 },
      hittable: true,
    },
    {
      index: 4,
      parentIndex: 3,
      depth: 4,
      type: 'Button',
      role: 'RCTButton',
      label: 'Add plant',
      rect: { x: 151, y: 640, width: 100, height: 32 },
      hittable: true,
    },
    {
      index: 5,
      parentIndex: 2,
      depth: 3,
      type: 'Toolbar',
      role: '_UIFloatingBarContainerView',
      label: 'Toolbar',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
  ]);

  assert.equal(annotated[4]?.interactionBlocked, 'covered');
});

test('a full-screen dialog sized to the content branch beside it still covers, because only chrome kinds are exempt (#2996 kind gate)', () => {
  // A `dialog` sibling that fills the branch is a real modal presentation over that branch. Reading
  // the exemption from geometry alone would let it through, so it must stay kind-gated to the
  // viewport-chrome family.
  const annotated = annotateCoveredSnapshotNodes([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      role: 'UIApplication',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      role: 'UIWindow',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      role: 'UILayoutContainerView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: 'Other',
      role: 'RCTRootContentView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 4,
      parentIndex: 3,
      depth: 4,
      type: 'Button',
      role: 'RCTButton',
      label: 'Add plant',
      rect: { x: 151, y: 74, width: 100, height: 32 },
      hittable: true,
    },
    {
      index: 5,
      parentIndex: 2,
      depth: 3,
      type: 'Dialog',
      role: 'UIAlertControllerView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
  ]);

  assert.equal(annotated[4]?.interactionBlocked, 'covered');
});

test('a chrome candidate in another window keeps covering content sized like its own frame (#2996 sibling scope)', () => {
  // The exemption compares a candidate against the siblings listed under ITS OWN parent. This
  // candidate's only sibling is its own full-window host, not the 791pt content branch living in the
  // app window, so nothing matches and it keeps covering — a same-size rect elsewhere in the tree
  // cannot excuse it.
  const appWindow: RawSnapshotNode[] = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      role: 'UIApplication',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      role: 'UIWindow',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      role: 'UILayoutContainerView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: 'Other',
      role: 'RCTRootContentView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
    {
      index: 4,
      parentIndex: 3,
      depth: 4,
      type: 'Button',
      role: 'RCTButton',
      label: 'Add plant',
      rect: { x: 151, y: 74, width: 100, height: 32 },
      hittable: true,
    },
  ];
  const overlayWindow: RawSnapshotNode[] = [
    {
      index: 5,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      role: 'UIWindow',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 6,
      parentIndex: 5,
      depth: 2,
      type: 'Toolbar',
      role: '_UIFloatingBarContainerView',
      label: 'Toolbar',
      rect: { x: 0, y: 0, width: 402, height: 791 },
      hittable: true,
    },
  ];

  const annotated = annotateCoveredSnapshotNodes([...appWindow, ...overlayWindow]);

  assert.equal(annotated[4]?.interactionBlocked, 'covered');
});

test('the captured iOS 27 tab-bar host container stops condemning every tab (#2996 live shape)', () => {
  // Verbatim shape from `snapshot --raw` on an iPhone 18 Pro running a JS-tab app: a badge container
  // and a content view are listed beside each other under the platter with identical 360x62 frames,
  // and the badge container covered the five tab buttons sitting inside its sibling.
  const platter = { x: 21, y: 791, width: 360, height: 62 };
  const annotated = annotateCoveredSnapshotNodes([
    {
      index: 128,
      parentIndex: 127,
      depth: 21,
      type: 'Other',
      role: '_UITouchPassthroughView',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 129,
      parentIndex: 128,
      depth: 22,
      type: 'Other',
      role: 'UIKit._UITabBarItemPlatterView',
      rect: platter,
      hittable: true,
    },
    {
      index: 131,
      parentIndex: 129,
      depth: 23,
      type: 'Other',
      role: '_TtCC5UIKit20_UITabBarPlatterViewContentView',
      rect: platter,
      hittable: true,
    },
    {
      index: 132,
      parentIndex: 131,
      depth: 24,
      type: 'Button',
      role: '_UITabButton',
      label: 'Home',
      rect: { x: 25, y: 795, width: 85.35, height: 54 },
      hittable: true,
    },
    {
      index: 142,
      parentIndex: 129,
      depth: 23,
      type: 'Other',
      role: '_TtCC5UIKit20_UITabBarPlatterViewBadgeContainerView',
      rect: platter,
      hittable: true,
    },
  ]);

  assert.equal(annotated.find((node) => node.label === 'Home')?.interactionBlocked, undefined);
});

test('the captured system-app bottom-bar container stops condemning the content and bar beside it (#2996 live shape)', () => {
  // Verbatim shape from `snapshot --raw` on a system app: a `Toolbar` published with the content
  // branch's 402x812 frame marked that branch's 36 nodes and the 402x54 navigation bar listed beside
  // it. The container paints nothing itself; its one child repeats its own frame.
  const contentArea = { x: 0, y: 62, width: 402, height: 812 };
  const annotated = annotateCoveredSnapshotNodes([
    { index: 5, parentIndex: 4, depth: 5, type: 'Other', rect: contentArea, hittable: true },
    { index: 6, parentIndex: 5, depth: 6, type: 'Other', rect: contentArea, hittable: true },
    {
      index: 7,
      parentIndex: 6,
      depth: 7,
      type: 'NavigationBar',
      label: 'Messages',
      rect: { x: 0, y: 78, width: 402, height: 54 },
      hittable: true,
    },
    { index: 8, parentIndex: 6, depth: 7, type: 'Other', rect: contentArea, hittable: true },
    {
      index: 19,
      parentIndex: 8,
      depth: 8,
      type: 'Button',
      label: 'Continue',
      rect: { x: 131, y: 700, width: 140, height: 44 },
      hittable: true,
    },
    {
      index: 48,
      parentIndex: 6,
      depth: 7,
      type: 'Toolbar',
      label: 'Toolbar',
      rect: contentArea,
      hittable: true,
    },
    {
      index: 49,
      parentIndex: 48,
      depth: 8,
      type: 'Other',
      rect: contentArea,
      hittable: true,
    },
  ]);

  assert.equal(annotated.find((node) => node.label === 'Continue')?.interactionBlocked, undefined);
  assert.equal(
    annotated.find((node) => node.type === 'NavigationBar')?.interactionBlocked,
    undefined,
  );
});

test('the kind fields join with a separator, so adjacent fragments never accidentally concatenate into a match', () => {
  // type "tab" + role "bar" must read as "tab bar" (no match for the
  // 'tabbar' overlay fragment) — never "tabbar" via an unseparated join,
  // which would misclassify this as floating chrome it is not.
  const target: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Save',
    rect: { x: 10, y: 10, width: 80, height: 40 },
  };
  const coincidental: RawSnapshotNode = {
    index: 1,
    type: 'tab',
    role: 'bar',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };

  const annotated = annotateCoveredSnapshotNodes([target, coincidental]);

  assert.equal(annotated[0]?.interactionBlocked, undefined);
});

test('a plain rect with no hittable/label/value/identifier is not a touch candidate and is never annotated', () => {
  const inert: RawSnapshotNode = {
    index: 0,
    type: 'group',
    role: 'group',
    rect: { x: 10, y: 10, width: 80, height: 40 },
  };
  const dialog: RawSnapshotNode = {
    index: 1,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };

  const annotated = annotateCoveredSnapshotNodes([inert, dialog]);

  assert.equal(annotated[0]?.interactionBlocked, undefined);
  assert.equal(annotated[0]?.hittable, undefined);
});

test('a node qualifies as a touch candidate through value or identifier alone, without a label', () => {
  const byValue: RawSnapshotNode = {
    index: 0,
    type: 'textfield',
    role: 'textfield',
    value: 'user@example.com',
    rect: { x: 10, y: 10, width: 80, height: 40 },
  };
  const byIdentifier: RawSnapshotNode = {
    index: 1,
    type: 'group',
    role: 'group',
    identifier: 'save-button',
    rect: { x: 10, y: 60, width: 80, height: 40 },
  };
  const dialog: RawSnapshotNode = {
    index: 2,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };

  const annotated = annotateCoveredSnapshotNodes([byValue, byIdentifier, dialog]);

  assert.equal(annotated[0]?.interactionBlocked, 'covered');
  assert.equal(annotated[1]?.interactionBlocked, 'covered');
});

test('a whitespace-only label, value, or identifier does not qualify a node as a touch candidate', () => {
  // Each field must be independently trimmed before the emptiness check, not
  // just present-and-truthy — a lone whitespace string is truthy in JS but
  // carries no real content.
  const whitespaceLabel: RawSnapshotNode = {
    index: 0,
    type: 'group',
    role: 'group',
    label: '   ',
    rect: { x: 0, y: 0, width: 40, height: 40 },
  };
  const whitespaceValue: RawSnapshotNode = {
    index: 1,
    type: 'group',
    role: 'group',
    value: '   ',
    rect: { x: 50, y: 0, width: 40, height: 40 },
  };
  const whitespaceIdentifier: RawSnapshotNode = {
    index: 2,
    type: 'group',
    role: 'group',
    identifier: '   ',
    rect: { x: 100, y: 0, width: 40, height: 40 },
  };
  const dialog: RawSnapshotNode = {
    index: 3,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };

  const annotated = annotateCoveredSnapshotNodes([
    whitespaceLabel,
    whitespaceValue,
    whitespaceIdentifier,
    dialog,
  ]);

  assert.equal(annotated[0]?.interactionBlocked, undefined);
  assert.equal(annotated[1]?.interactionBlocked, undefined);
  assert.equal(annotated[2]?.interactionBlocked, undefined);
});

test('a node qualifies as a touch candidate through a semantic role alone, without hittable/label/value/identifier', () => {
  const semantic: RawSnapshotNode = {
    index: 0,
    type: 'checkbox',
    role: 'checkbox',
    rect: { x: 10, y: 10, width: 30, height: 30 },
  };
  const dialog: RawSnapshotNode = {
    index: 1,
    type: 'dialog',
    role: 'dialog',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  };

  const annotated = annotateCoveredSnapshotNodes([semantic, dialog]);

  assert.equal(annotated[0]?.interactionBlocked, 'covered');
});
