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

// --- selector-miss: genuine containment, via scrollRegion (preferred over ancestry) ---

test('selector-miss + scrollRegion still contains a descendant -> record-and-heal', () => {
  const evidence = saveButtonEvidence({
    ancestry: [{ role: 'cell' }],
    scrollRegion: { role: 'scrollview', id: 'editor-scroll' },
  });
  const nodes = toSnapshotNodes([
    { index: 0, type: 'scrollview', identifier: 'editor-scroll' },
    { index: 1, type: 'cell', label: 'Row 1 (renamed)', parentIndex: 0 },
  ]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'record-and-heal');
});

test('selector-miss + scrollRegion node exists but is empty -> state-repair', () => {
  const evidence = saveButtonEvidence({
    scrollRegion: { role: 'scrollview', id: 'editor-scroll' },
  });
  const nodes = toSnapshotNodes([{ index: 0, type: 'scrollview', identifier: 'editor-scroll' }]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'state-repair');
});

test('selector-miss + scrollRegion entirely absent -> state-repair', () => {
  const evidence = saveButtonEvidence({
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

// --- root-level target with no ancestry and no scrollRegion: falls back to "capture has any content" ---

test('selector-miss with no ancestry/scrollRegion falls back to non-empty capture -> record-and-heal', () => {
  const evidence = saveButtonEvidence({ ancestry: [] });
  const nodes = toSnapshotNodes([{ index: 0, type: 'toolbar', label: 'Editor' }]);
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE(nodes),
  });
  assert.equal(hint, 'record-and-heal');
});

test('selector-miss with no ancestry/scrollRegion and an empty capture -> state-repair', () => {
  const evidence = saveButtonEvidence({ ancestry: [] });
  const hint = computeReplayRepairHint({
    kind: 'selector-miss',
    targetEvidence: evidence,
    capture: AVAILABLE([]),
  });
  assert.equal(hint, 'state-repair');
});
