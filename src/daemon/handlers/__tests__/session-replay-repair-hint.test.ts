import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RawSnapshotNode, SnapshotNode } from '../../../kernel/snapshot.ts';
import type { TargetAnnotationV1 } from '../../../replay/target-identity.ts';
import {
  computeReplayRepairHint,
  type ReplayRepairHintCapture,
} from '../session-replay-repair-hint.ts';

/**
 * ADR 0012 decision 6, R3: `computeReplayRepairHint` must be a TOTAL mapping
 * over (kind x recorded-evidence-presence x capture-availability) — every
 * combination below resolves to a defined enum, including both fail-safes to
 * `manual` (no recorded evidence; sparse/unavailable capture). The
 * container-presence test is genuine ANCESTOR CONTAINMENT walked over
 * `parentIndex` — not a flat identity-string search — so several cases below
 * specifically distinguish "a node sharing the container's role/label exists
 * somewhere" from "the container genuinely still has a child".
 */

function toSnapshotNodes(raw: RawSnapshotNode[]): SnapshotNode[] {
  return raw.map((node, position) => ({ ...node, ref: `e${position + 1}` }));
}

function saveButtonEvidence(overrides: Partial<TargetAnnotationV1> = {}): TargetAnnotationV1 {
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

const AVAILABLE = (nodes: SnapshotNode[]): ReplayRepairHintCapture => ({
  state: 'available',
  nodes,
});
const UNAVAILABLE: ReplayRepairHintCapture = { state: 'unavailable' };

// --- selector-miss: genuine containment, via ancestry ---

test('selector-miss + container still has a child (the renamed sibling) -> record-and-heal', () => {
  // The "Save" button was renamed to "Save Draft" (identity no longer
  // matches), but it is still a CHILD of the recorded toolbar container.
  const nodes = toSnapshotNodes([
    { index: 0, type: 'toolbar', label: 'Editor' },
    { index: 1, type: 'button', label: 'Save Draft', parentIndex: 0 },
  ]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: saveButtonEvidence(),
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'record-and-heal');
});

test('a node sharing the container role/label elsewhere, with no children, is NOT containment -> state-repair', () => {
  // A decoy toolbar with the SAME role/label exists (e.g. shared app chrome
  // on a different screen), but it has zero children: nothing is actually
  // contained. A flat identity-string search would wrongly say "present";
  // genuine containment correctly says absent.
  const nodes = toSnapshotNodes([{ index: 0, type: 'toolbar', label: 'Editor' }]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: saveButtonEvidence(),
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'state-repair');
});

test('selector-miss + recorded container entirely absent (different screen) -> state-repair', () => {
  const nodes = toSnapshotNodes([
    { index: 0, type: 'window', label: 'Onboarding' },
    { index: 1, type: 'button', label: 'Continue', parentIndex: 0 },
  ]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: saveButtonEvidence(),
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'state-repair');
});

// --- scrollRegion: an IDENTIFIED region is trusted (AND ancestry); an
// UNIDENTIFIED region is NOT a standalone presence signal (P0 false positive). ---

// A recorded target inside an identified list: parent is a cell, whose parent
// is the identified scrollview; the scrollRegion carries the list's id.
function listRowEvidence(overrides: Partial<TargetAnnotationV1> = {}): TargetAnnotationV1 {
  return saveButtonEvidence({
    ancestry: [{ role: 'cell' }, { role: 'scrollview' }],
    scrollRegion: { role: 'scrollview', id: 'editor-scroll' },
    ...overrides,
  });
}

// The same list, still present, with the leaf renamed (its structural
// location — cell inside the identified scrollview — is unchanged).
function listRowCapture(): SnapshotNode[] {
  return toSnapshotNodes([
    { index: 0, type: 'scrollview', identifier: 'editor-scroll' },
    { index: 1, type: 'cell', label: 'Row', parentIndex: 0 },
    { index: 2, type: 'button', label: 'Save Draft', parentIndex: 1 },
  ]);
}

test('selector-miss + IDENTIFIED scrollRegion present AND ancestry present -> record-and-heal', () => {
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: listRowEvidence(),
    capture: AVAILABLE(listRowCapture()),
  });
  assert.equal(hint, 'record-and-heal');
});

test('selector-miss + LABEL-identified scrollRegion present AND ancestry present -> record-and-heal', () => {
  const evidence = listRowEvidence({ scrollRegion: { role: 'scrollview', label: 'Editor list' } });
  const nodes = toSnapshotNodes([
    { index: 0, type: 'scrollview', label: 'Editor list' },
    { index: 1, type: 'cell', label: 'Row', parentIndex: 0 },
    { index: 2, type: 'button', label: 'Save Draft', parentIndex: 1 },
  ]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'record-and-heal');
});

test('selector-miss + IDENTIFIED scrollRegion absent (ancestry present but wrong list) -> state-repair', () => {
  // The recorded cell/scrollview structure exists, but the scrollview carries
  // a DIFFERENT id — the AND fails on the region, so this is not the same list.
  const nodes = toSnapshotNodes([
    { index: 0, type: 'scrollview', identifier: 'other-scroll' },
    { index: 1, type: 'cell', label: 'Row', parentIndex: 0 },
    { index: 2, type: 'button', label: 'Save Draft', parentIndex: 1 },
  ]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: listRowEvidence(),
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'state-repair');
});

// P0: an UNIDENTIFIED scrollRegion (RN's default ScrollView/FlatList with no
// testID) must NOT read as present just because some anonymous scrollview
// exists — the pre-fix scrollRegion-only shortcut healed against the wrong
// screen. It falls back to the ancestry containment test.
test('selector-miss + UNIDENTIFIED scrollRegion on an UNRELATED screen -> state-repair (not record-and-heal)', () => {
  const evidence = listRowEvidence({
    scrollRegion: { role: 'scrollview' }, // no id AND no label
  });
  // A totally different screen whose only coincidence is an anonymous
  // scrollview; nothing carries the recorded cell/scrollview ancestry.
  const nodes = toSnapshotNodes([
    { index: 0, type: 'scrollview' },
    { index: 1, type: 'button', label: 'Continue', parentIndex: 0 },
  ]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'state-repair');
});

test('action-failure + UNIDENTIFIED scrollRegion on an UNRELATED screen -> manual (not record-and-heal)', () => {
  const evidence = listRowEvidence({ scrollRegion: { role: 'scrollview' } });
  const nodes = toSnapshotNodes([
    { index: 0, type: 'scrollview' },
    { index: 1, type: 'button', label: 'Continue', parentIndex: 0 },
  ]);
  const hint = computeReplayRepairHint({
    kind: 'action-failure',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'manual');
});

test('selector-miss + UNIDENTIFIED scrollRegion but ancestry still present -> record-and-heal', () => {
  // The unidentified region is ignored, but the recorded ancestry chain is
  // genuinely still contained, so heal-by-doing is safe.
  const evidence = listRowEvidence({ scrollRegion: { role: 'scrollview' } });
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(listRowCapture()),
  });
  assert.equal(hint, 'record-and-heal');
});

test('selector-miss + full recorded ancestry chain absent (only the parent role coincides) -> state-repair', () => {
  // A screen that reuses the immediate-parent role (toolbar) as shared chrome
  // but NOT the deeper recorded chain — walking the whole chain, not just
  // ancestry[0], correctly reports absent.
  const evidence = saveButtonEvidence({
    ancestry: [{ role: 'toolbar', label: 'Editor' }, { role: 'navbar' }],
  });
  const nodes = toSnapshotNodes([
    { index: 0, type: 'window' },
    { index: 1, type: 'toolbar', label: 'Editor', parentIndex: 0 },
    { index: 2, type: 'button', label: 'Save Draft', parentIndex: 1 },
  ]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'state-repair');
});

// --- identity-mismatch: always caution, capture is irrelevant ---

test('identity-mismatch -> caution regardless of capture', () => {
  const populated = toSnapshotNodes([
    { index: 0, type: 'toolbar', label: 'Editor' },
    { index: 1, type: 'button', label: 'Save Draft', parentIndex: 0 },
  ]);
  assert.equal(
    computeReplayRepairHint({
      kind: 'identity-mismatch',
      targetEvidence: saveButtonEvidence(),
      capture: AVAILABLE(populated),
    }),
    'caution',
  );
  assert.equal(
    computeReplayRepairHint({
      kind: 'identity-mismatch',
      targetEvidence: undefined,
      capture: UNAVAILABLE,
    }),
    'caution',
  );
});

// --- identity-unverifiable: always manual, capture is irrelevant ---

test('identity-unverifiable -> manual regardless of capture', () => {
  const populated = toSnapshotNodes([
    { index: 0, type: 'toolbar', label: 'Editor' },
    { index: 1, type: 'button', label: 'Save Draft', parentIndex: 0 },
  ]);
  assert.equal(
    computeReplayRepairHint({
      kind: 'identity-unverifiable',
      targetEvidence: saveButtonEvidence(),
      capture: AVAILABLE(populated),
    }),
    'manual',
  );
  assert.equal(
    computeReplayRepairHint({
      kind: 'identity-unverifiable',
      targetEvidence: undefined,
      capture: UNAVAILABLE,
    }),
    'manual',
  );
});

// --- action-failure: same containment test, but "absent" verdict is manual, not state-repair ---

test('action-failure + container still has a child (post-response capture) -> record-and-heal', () => {
  const nodes = toSnapshotNodes([
    { index: 0, type: 'toolbar', label: 'Editor' },
    { index: 1, type: 'button', label: 'Save Draft', parentIndex: 0 },
  ]);
  const hint = computeReplayRepairHint({
    kind: 'action-failure',
    targetEvidence: saveButtonEvidence(),
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'record-and-heal');
});

test('action-failure + recorded container absent -> manual (not state-repair)', () => {
  const nodes = toSnapshotNodes([{ index: 0, type: 'window', label: 'Onboarding' }]);
  const hint = computeReplayRepairHint({
    kind: 'action-failure',
    targetEvidence: saveButtonEvidence(),
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'manual');
});

// --- fail-safe 1: no recorded targetEvidence -> manual (both reachable kinds) ---

test('fail-safe: no recorded targetEvidence on an action-failure -> manual', () => {
  const nodes = toSnapshotNodes([{ index: 0, type: 'toolbar', label: 'Editor' }]);
  const hint = computeReplayRepairHint({
    kind: 'action-failure',
    targetEvidence: undefined,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'manual');
});

test('fail-safe: no recorded targetEvidence on a selector-miss -> manual', () => {
  const nodes = toSnapshotNodes([{ index: 0, type: 'toolbar', label: 'Editor' }]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: undefined,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'manual');
});

// --- fail-safe 2: sparse/unavailable capture -> manual, even with recorded evidence ---

test('fail-safe: unavailable capture on a selector-miss -> manual', () => {
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: saveButtonEvidence(),
    capture: UNAVAILABLE,
  });
  assert.equal(hint, 'manual');
});

test('fail-safe: unavailable capture on an action-failure -> manual', () => {
  const hint = computeReplayRepairHint({
    kind: 'action-failure',
    targetEvidence: saveButtonEvidence(),
    capture: UNAVAILABLE,
  });
  assert.equal(hint, 'manual');
});

// --- fail-safe 3: NO usable structural container signal (empty ancestry AND
// no/unidentified scrollRegion) -> manual, never record-and-heal on an
// unrelated screen (same mis-binding class as the unidentified-region P0). ---

test('selector-miss with no ancestry/scrollRegion on an unrelated screen -> manual (not record-and-heal)', () => {
  const evidence = saveButtonEvidence({ ancestry: [] });
  const nodes = toSnapshotNodes([{ index: 0, type: 'toolbar', label: 'Editor' }]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'manual');
});

test('action-failure with no ancestry/scrollRegion on an unrelated screen -> manual', () => {
  const evidence = saveButtonEvidence({ ancestry: [] });
  const nodes = toSnapshotNodes([{ index: 0, type: 'toolbar', label: 'Editor' }]);
  const hint = computeReplayRepairHint({
    kind: 'action-failure',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'manual');
});

test('no ancestry but an UNIDENTIFIED scrollRegion is still no usable signal -> manual', () => {
  const evidence = saveButtonEvidence({ ancestry: [], scrollRegion: { role: 'scrollview' } });
  const nodes = toSnapshotNodes([{ index: 0, type: 'scrollview' }]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'manual');
});

test('no ancestry but an IDENTIFIED scrollRegion IS a usable signal -> record-and-heal when the region is present', () => {
  const evidence = saveButtonEvidence({
    ancestry: [],
    scrollRegion: { role: 'scrollview', id: 'editor-scroll' },
  });
  const nodes = toSnapshotNodes([
    { index: 0, type: 'scrollview', identifier: 'editor-scroll' },
    { index: 1, type: 'button', label: 'Save Draft', parentIndex: 0 },
  ]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'record-and-heal');
});

test('no ancestry + IDENTIFIED scrollRegion absent -> state-repair (selector-miss)', () => {
  const evidence = saveButtonEvidence({
    ancestry: [],
    scrollRegion: { role: 'scrollview', id: 'editor-scroll' },
  });
  const nodes = toSnapshotNodes([{ index: 0, type: 'window', label: 'Onboarding' }]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'state-repair');
});
