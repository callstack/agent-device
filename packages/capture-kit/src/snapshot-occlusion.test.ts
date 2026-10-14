import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { SNAPSHOT_COVERING_LABEL_MAX_LENGTH } from '@agent-device/kernel/snapshot';
import {
  annotateCoveredSnapshotNodes,
  annotateSnapshotNodesCoveredByPolicy,
} from './snapshot-occlusion.ts';

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

test('annotateCoveredSnapshotNodes carries a bounded description of the covering node', () => {
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
    type: 'XCUIElementTypeDialog',
    label: '  Cookie banner  ',
    rect: { x: 0, y: 0, width: 200, height: 200 },
  };

  const result = annotateCoveredSnapshotNodes([target, overlay]);

  // The description is the presented role + a trimmed label + the cover's rect, and it carries no
  // ref: naming the culprit is diagnosis, never an actionable re-target.
  assert.deepEqual(result[0]?.coveredBy, {
    kind: 'dialog',
    label: 'Cookie banner',
    rect: { x: 0, y: 0, width: 200, height: 200 },
  });
});

test('annotateCoveredSnapshotNodes clips a covering label to the bounded length', () => {
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
    label: 'x'.repeat(SNAPSHOT_COVERING_LABEL_MAX_LENGTH + 40),
    rect: { x: 0, y: 0, width: 200, height: 200 },
  };

  const result = annotateCoveredSnapshotNodes([target, overlay]);

  assert.equal(result[0]?.coveredBy?.label?.length, SNAPSHOT_COVERING_LABEL_MAX_LENGTH);
});

// Shapes below are the live iPhone 18 Pro (iOS 27.0) capture of the Agent Device Tester home tab
// with its confirmation alert open. The alert's container publishes as the generic `group` kind and
// is only recognizable through the alert title carried as its accessible label.
const LIVE_HOME_APPLICATION: RawSnapshotNode = {
  index: 0,
  type: 'Application',
  role: 'UIApplication',
  label: 'Agent Device Tester',
  rect: { x: 0, y: 0, width: 402, height: 874 },
};

const LIVE_COVERED_SWITCH: RawSnapshotNode = {
  index: 1,
  type: 'Switch',
  role: 'UISwitch',
  label: 'Lab online',
  value: '1',
  hittable: true,
  parentIndex: 0,
  rect: { x: 304.6666774749756, y: 322.66666634877515, width: 63, height: 28 },
};

const LIVE_ALERT_CONTAINER: RawSnapshotNode = {
  index: 2,
  type: 'Group',
  role: '_UIAlertControllerPhoneTVMacView',
  label: 'Confirm catalog refresh',
  hittable: true,
  parentIndex: 0,
  rect: { x: 41, y: 327, width: 320, height: 248 },
};

test('a live alert container is named through the label it publishes, not its generic kind', () => {
  const result = annotateCoveredSnapshotNodes([
    LIVE_HOME_APPLICATION,
    LIVE_COVERED_SWITCH,
    LIVE_ALERT_CONTAINER,
  ]);

  assert.equal(result[1]?.interactionBlocked, 'covered');
  assert.deepEqual(result[1]?.coveredBy, {
    kind: 'group',
    label: 'Confirm catalog refresh',
    rect: { x: 41, y: 327, width: 320, height: 248 },
  });
});

test('an anonymous container cover publishes no cover instead of naming a faceless box', () => {
  // Same live nodes with the alert title removed: `the group at (41, 327 320x248)` describes a box
  // no reader would recognize or dismiss, so the refusal falls back to the generic recovery.
  const result = annotateCoveredSnapshotNodes([
    LIVE_HOME_APPLICATION,
    LIVE_COVERED_SWITCH,
    { ...LIVE_ALERT_CONTAINER, label: undefined },
  ]);

  assert.equal(result[1]?.interactionBlocked, 'covered');
  assert.equal(result[1]?.hittable, false);
  assert.equal(result[1]?.coveredBy, undefined);
});

test('a named cover kind still describes itself with no label to lean on', () => {
  const result = annotateCoveredSnapshotNodes([
    LIVE_HOME_APPLICATION,
    LIVE_COVERED_SWITCH,
    { ...LIVE_ALERT_CONTAINER, type: 'Sheet', role: undefined, label: undefined },
  ]);

  assert.deepEqual(result[1]?.coveredBy, {
    kind: 'sheet',
    rect: { x: 41, y: 327, width: 320, height: 248 },
  });
});

test('annotateSnapshotNodesCoveredByPolicy refuses without guessing a cover', () => {
  // The Android replacement-surface lane reports only the covered boolean; the refusal must not
  // invent a culprit it never observed.
  const target: RawSnapshotNode = {
    index: 0,
    type: 'button',
    role: 'button',
    hittable: true,
    label: 'Save',
    rect: { x: 10, y: 10, width: 100, height: 40 },
  };

  const result = annotateSnapshotNodesCoveredByPolicy([target], (node) => node.index === 0);

  assert.equal(result[0]?.interactionBlocked, 'covered');
  assert.equal(result[0]?.coveredBy, undefined);
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
