import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotNode } from '../../../kernel/snapshot.ts';
import type { TargetAnnotationV1 } from '../../../replay/target-identity.ts';
import { classifyReplayTarget } from '../session-replay-target-classification.ts';
import {
  bottomTabsRealCaptureFixture,
  recordArticleEvidence,
  toSnapshotNodes,
} from './session-replay-target-classification-fixtures.ts';

/** Verified outcomes carry the verified member + matchCount (for the post-resolution guard). */
function assertVerified(
  result: ReturnType<typeof classifyReplayTarget>,
  expected: { winnerRef: string; matchCount: number },
): void {
  assert.equal(result.verified, true);
  if (!result.verified) throw new Error('unreachable');
  assert.equal(result.winnerNode.ref, expected.winnerRef);
  assert.equal(result.matchCount, expected.matchCount);
}

const PLATFORM = 'ios' as const;

test('classifyReplayTarget: real-capture fixture verifies by @ref when the tree is unchanged', () => {
  const recorded = recordArticleEvidence();
  const replayNodes = bottomTabsRealCaptureFixture();
  const winner = replayNodes.find((node) => node.label === 'Article, unselected');
  assert.ok(winner);
  const result = classifyReplayTarget({
    recorded,
    token: `@${winner.ref}`,
    nodes: replayNodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });
  assertVerified(result, { winnerRef: winner.ref, matchCount: 1 });
});

test('classifyReplayTarget: real-capture fixture — a relabeled node is identity-mismatch (path 3)', () => {
  const recorded = recordArticleEvidence();
  const replayNodes = bottomTabsRealCaptureFixture();
  const winner = replayNodes.find((node) => node.label === 'Article, unselected');
  assert.ok(winner);
  // The id/label both changed (a real rename) but the selector (id="article")
  // still resolves — the recorded id no longer matches anything.
  winner.identifier = 'articles-tab';
  winner.label = 'Articles, unselected';
  const result = classifyReplayTarget({
    recorded,
    token: 'id="article"',
    nodes: replayNodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });
  assert.equal(result.verified, false);
  if (result.verified) throw new Error('unreachable');
  assert.equal(result.kind, 'selector-miss');
  assert.equal(result.matchCount, 0);
});

// ---------------------------------------------------------------------------
// Path 1 is caller-side (session-replay-target-verification.ts checks
// `recorded.verification === 'unverifiable'` before ever calling
// classifyReplayTarget) — covered by the wire-level test file instead.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Minimal synthetic fixture for the remaining paths: a toolbar with a save
// button, isolated from the real-capture tree's own structure so each path's
// setup stays legible.
// ---------------------------------------------------------------------------

function saveButtonRecorded(overrides: Partial<TargetAnnotationV1> = {}): TargetAnnotationV1 {
  return {
    id: 'save',
    role: 'button',
    label: 'Save',
    ancestry: [{ role: 'toolbar', label: 'Editor' }],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
    ...overrides,
  };
}

function saveButtonTree(): SnapshotNode[] {
  return toSnapshotNodes([
    { index: 0, type: 'Window', depth: 0 },
    { index: 1, type: 'Toolbar', label: 'Editor', depth: 1, parentIndex: 0 },
    {
      index: 2,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 10, y: 10, width: 40, height: 20 },
      depth: 2,
      parentIndex: 1,
    },
  ]);
}

test('classifyReplayTarget path 2: selector-miss when the recorded target is gone', () => {
  const recorded = saveButtonRecorded();
  const nodes = toSnapshotNodes([
    { index: 0, type: 'Window', depth: 0 },
    { index: 1, type: 'Toolbar', label: 'Editor', depth: 1, parentIndex: 0 },
  ]);
  const result = classifyReplayTarget({
    recorded,
    token: 'id="save"',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });
  assert.equal(result.verified, false);
  if (result.verified) throw new Error('unreachable');
  assert.equal(result.kind, 'selector-miss');
  assert.equal(result.matchCount, 0);
  assert.deepEqual(result.candidateNodes, []);
});

test('classifyReplayTarget path 4: verified via @ref on an unchanged tree', () => {
  const recorded = saveButtonRecorded();
  const nodes = saveButtonTree();
  const result = classifyReplayTarget({
    recorded,
    token: '@e3',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });
  assertVerified(result, { winnerRef: 'e3', matchCount: 1 });
});

test('classifyReplayTarget uses the later chain alternative that resolution selected after an earlier tie', () => {
  const nodes = toSnapshotNodes([
    {
      index: 0,
      type: 'Button',
      label: 'Ambiguous',
      rect: { x: 0, y: 0, width: 40, height: 20 },
      depth: 1,
    },
    {
      index: 1,
      type: 'Button',
      label: 'Ambiguous',
      rect: { x: 60, y: 0, width: 40, height: 20 },
      depth: 1,
    },
    {
      index: 2,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 0, y: 40, width: 40, height: 20 },
      depth: 1,
    },
  ]);

  const result = classifyReplayTarget({
    recorded: saveButtonRecorded({ ancestry: [], sibling: 2 }),
    token: 'label="Ambiguous" || id="save"',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });

  // The first alternative ties, so `resolveSelectorChain` skips it and
  // selects `id="save"`. Deriving the domain from the first matching
  // alternative would report two ambiguous buttons instead of this one winner.
  assertVerified(result, { winnerRef: 'e3', matchCount: 1 });
});

test('classifyReplayTarget path 4: verified by ref-label fallback when the ref itself is stale', () => {
  const recorded = saveButtonRecorded();
  const nodes = saveButtonTree();
  const result = classifyReplayTarget({
    recorded,
    // A ref from a different session/generation never present in this tree.
    token: '@e999',
    nodes,
    platform: PLATFORM,
    refLabel: 'Save',
    requireRect: true,
    allowDisambiguation: true,
  });
  assertVerified(result, { winnerRef: 'e3', matchCount: 1 });
});

test('classifyReplayTarget: an unparseable-but-@-ref token with no fallback label is a selector-miss', () => {
  const recorded = saveButtonRecorded();
  const nodes = saveButtonTree();
  const result = classifyReplayTarget({
    recorded,
    token: '@e999',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });
  assert.equal(result.verified, false);
  if (result.verified) throw new Error('unreachable');
  assert.equal(result.kind, 'selector-miss');
});

test('classifyReplayTarget path 5: a unique-but-wrong rebind is caught even when resolution is unique', () => {
  const recorded = saveButtonRecorded({ ancestry: [] });
  // Two "Go back" buttons at different depths: the label-only selector
  // matches both, but only one carries the recorded id. The disambiguation
  // heuristic (deepest-then-smallest-area) prefers the decoy.
  const nodes = toSnapshotNodes([
    { index: 0, type: 'Window', rect: { x: 0, y: 0, width: 400, height: 800 }, depth: 0 },
    {
      index: 1,
      type: 'Button',
      identifier: 'go-back-real',
      label: 'Go back',
      rect: { x: 0, y: 0, width: 40, height: 20 },
      depth: 2,
      parentIndex: 0,
    },
    {
      index: 2,
      type: 'Button',
      identifier: 'go-back-decoy',
      label: 'Go back',
      rect: { x: 100, y: 100, width: 40, height: 20 },
      depth: 5,
      parentIndex: 0,
    },
  ]);
  const goBackRecorded: TargetAnnotationV1 = {
    ...recorded,
    id: 'go-back-real',
    label: 'Go back',
  };
  const result = classifyReplayTarget({
    recorded: goBackRecorded,
    token: 'label="Go back"',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });
  assert.equal(result.verified, false);
  if (result.verified) throw new Error('unreachable');
  assert.equal(result.kind, 'identity-mismatch');
  assert.equal(result.matchCount, 2);
  assert.equal(result.observedNode?.ref, 'e3'); // the decoy (index 2 -> e3), not the recorded winner
});

// ---------------------------------------------------------------------------
// Path 6: same local identity recurring under different (anonymous) parents,
// disambiguated by sibling ordinal, then by region-scoped viewportOrder.
// ---------------------------------------------------------------------------

function duplicateRowTree(): SnapshotNode[] {
  return toSnapshotNodes([
    { index: 0, type: 'Window', depth: 0 },
    { index: 1, type: 'ScrollView', identifier: 'list', depth: 1, parentIndex: 0 },
    // Two anonymous section wrappers (role only, no label) — a real
    // SectionList/FlatList shape.
    { index: 2, type: 'Other', depth: 2, parentIndex: 1 },
    { index: 3, type: 'Other', depth: 2, parentIndex: 1 },
    // Section A's rows (sibling 0, 1 within their own parent). Row 0 is
    // uniquely deepest so the disambiguation heuristic (deepest-then-
    // smallest-area) always picks it deterministically when ambiguous — used
    // to exercise a genuine path-6-verified winner below.
    {
      index: 4,
      type: 'Button',
      label: 'Row',
      rect: { x: 0, y: 100, width: 100, height: 20 },
      depth: 4,
      parentIndex: 2,
    },
    {
      index: 5,
      type: 'Button',
      label: 'Row',
      rect: { x: 0, y: 150, width: 100, height: 20 },
      depth: 3,
      parentIndex: 2,
    },
    // Section B's rows — SAME sibling ordinals (0, 1) recurring under a
    // DIFFERENT parent.
    {
      index: 6,
      type: 'Button',
      label: 'Row',
      rect: { x: 0, y: 200, width: 100, height: 20 },
      depth: 3,
      parentIndex: 3,
    },
    {
      index: 7,
      type: 'Button',
      label: 'Row',
      rect: { x: 0, y: 250, width: 100, height: 20 },
      depth: 3,
      parentIndex: 3,
    },
  ]);
}

function duplicateRowRecorded(overrides: Partial<TargetAnnotationV1> = {}): TargetAnnotationV1 {
  return {
    role: 'button',
    label: 'Row',
    ancestry: [{ role: 'other' }],
    sibling: 0,
    viewportOrder: 0,
    scrollRegion: { role: 'scrollview', id: 'list' },
    verification: 'verified',
    ...overrides,
  };
}

test('classifyReplayTarget path 6: same sibling ordinal recurring under a different parent falls through to region-scoped viewportOrder', () => {
  const nodes = duplicateRowTree();
  const recorded = duplicateRowRecorded(); // recorded winner: index 4 (e5), sibling 0, viewportOrder 0
  const result = classifyReplayTarget({
    recorded,
    token: 'role=button label="Row"',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    // e5 is the uniquely-deepest match, so the real resolution has a
    // genuine (non-tied) winner here — exercising path 6's compare-with-W
    // step, not just the identity-set/region math in isolation.
    allowDisambiguation: true,
  });
  // Sibling ordinal 0 recurs under both anonymous sections (e5 and e7): the
  // sibling signal alone cannot isolate. Region-scoped viewportOrder (all
  // four rows share ONE scroll region, ordered by rect center) resolves it
  // to the topmost row, e5 — which is also the real resolution winner.
  assertVerified(result, { winnerRef: 'e5', matchCount: 4 });
});

test('classifyReplayTarget path 6: viewport order resolves a lower row via document order within its region', () => {
  const nodes = duplicateRowTree();
  const recorded = duplicateRowRecorded({ viewportOrder: 2 }); // third row top-to-bottom: e7 (Section B, sibling 0)
  const result = classifyReplayTarget({
    recorded,
    token: 'role=button label="Row"',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: false,
  });
  assert.equal(result.verified, false);
  if (result.verified) throw new Error('unreachable');
  // e7 was recorded but the CURRENT resolution winner is whatever the
  // (disabled) disambiguation left as matchList's first match — a mismatch,
  // not a verify, proving viewportOrder actually selected e7 as the
  // evidence-denoted member rather than silently accepting matchList's
  // first hit.
  assert.equal(result.kind, 'identity-mismatch');
});

test('classifyReplayTarget path 6: a recorded scroll region that no longer exists is unavailable, never compared cross-region', () => {
  const nodes = duplicateRowTree();
  // The recorded scroll region ("list") no longer exists in the replay tree.
  for (const node of nodes) {
    if (node.identifier === 'list') node.identifier = 'list-renamed';
  }
  const recorded = duplicateRowRecorded();
  const result = classifyReplayTarget({
    recorded,
    token: 'role=button label="Row"',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: false,
  });
  assert.equal(result.verified, false);
  if (result.verified) throw new Error('unreachable');
  assert.equal(result.kind, 'identity-unverifiable');
  assert.equal(result.matchCount, 4);
  assert.equal(result.candidateNodes.length, 4);
  // Document order: the candidates list is exactly the identity set in tree order.
  assert.deepEqual(
    result.candidateNodes.map((node) => node.ref),
    ['e5', 'e6', 'e7', 'e8'],
  );
});

test('classifyReplayTarget path 6: an out-of-range recorded viewportOrder falls through to identity-unverifiable', () => {
  const nodes = duplicateRowTree();
  const recorded = duplicateRowRecorded({ viewportOrder: 99 });
  const result = classifyReplayTarget({
    recorded,
    token: 'role=button label="Row"',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: false,
  });
  assert.equal(result.verified, false);
  if (result.verified) throw new Error('unreachable');
  assert.equal(result.kind, 'identity-unverifiable');
  assert.equal(result.matchCount, 4);
});

test('classifyReplayTarget: document-order determinism for equal rect centers', () => {
  // Two candidates under different anonymous sections (sibling 0 recurs, so
  // that signal never isolates), with IDENTICAL rect centers — the ONLY way
  // `orderByViewportPosition` can order them is its document-order
  // tie-break. The first one (index 2, uniquely deepest so its OWN
  // resolution winner is unambiguous) is recorded at viewportOrder 0; if the
  // tie-break were nondeterministic or reversed, the winner (e3) would not
  // match `orderedRegion[0]` and this would report a mismatch instead of
  // verified.
  const nodes = toSnapshotNodes([
    { index: 0, type: 'ScrollView', identifier: 'list', depth: 0 },
    { index: 1, type: 'Other', depth: 1, parentIndex: 0 },
    { index: 2, type: 'Other', depth: 1, parentIndex: 0 },
    {
      index: 3,
      type: 'Button',
      label: 'Row',
      rect: { x: 0, y: 100, width: 100, height: 20 },
      depth: 3, // uniquely deepest -> unambiguous real resolution winner
      parentIndex: 1,
    },
    {
      index: 4,
      type: 'Button',
      label: 'Row',
      rect: { x: 0, y: 100, width: 100, height: 20 }, // identical center to index 3
      depth: 2,
      parentIndex: 2,
    },
  ]);
  const recorded = duplicateRowRecorded({ sibling: 0, viewportOrder: 0 });
  const result = classifyReplayTarget({
    recorded,
    token: 'role=button label="Row"',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });
  assertVerified(result, { winnerRef: 'e4', matchCount: 2 });
});

// ---------------------------------------------------------------------------
