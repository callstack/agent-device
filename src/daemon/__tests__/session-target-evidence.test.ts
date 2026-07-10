import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RawSnapshotNode, SnapshotNode } from '../../kernel/snapshot.ts';
import { computeTargetEvidence } from '../session-target-evidence.ts';
import {
  parseTargetAnnotationV1Payload,
  serializeTargetAnnotationV1,
  utf8ByteLength,
  TARGET_ANNOTATION_MAX_ANCESTRY,
  TARGET_ANNOTATION_MAX_FIELD_BYTES,
  TARGET_ANNOTATION_MAX_PAYLOAD_BYTES,
} from '../../replay/target-identity.ts';

function toSnapshotNodes(raw: RawSnapshotNode[]): SnapshotNode[] {
  return raw.map((node, position) => ({ ...node, ref: `e${position + 1}` }));
}

function findByLabel(nodes: SnapshotNode[], label: string): SnapshotNode {
  const found = nodes.find((node) => node.label === label);
  if (!found) throw new Error(`fixture missing node with label ${label}`);
  return found;
}

// ---------------------------------------------------------------------------
// Basic record-time write algorithm (decision 3 steps 1-5)
// ---------------------------------------------------------------------------

function toolbarFixture(): SnapshotNode[] {
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

test('computeTargetEvidence: single unambiguous node is verified with the expected identity/ancestry/rect', () => {
  const nodes = toolbarFixture();
  const winner = findByLabel(nodes, 'Save');
  const evidence = computeTargetEvidence({ node: winner, preActionNodes: nodes });
  assert.ok(evidence);
  assert.deepEqual(evidence, {
    id: 'save',
    role: 'button',
    label: 'Save',
    ancestry: [{ role: 'toolbar', label: 'Editor' }, { role: 'window' }],
    sibling: 0,
    viewportOrder: 0,
    rect: { x: 10, y: 10, width: 40, height: 20 },
    verification: 'verified',
  });
});

// ---------------------------------------------------------------------------
// Scroll region + viewport order
// ---------------------------------------------------------------------------

function scrollableListFixture(): SnapshotNode[] {
  return toSnapshotNodes([
    { index: 0, type: 'Window', depth: 0 },
    {
      index: 1,
      type: 'ScrollView',
      identifier: 'editor-scroll',
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      type: 'Cell',
      label: 'Row',
      rect: { x: 0, y: 100, width: 100, height: 20 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 3,
      type: 'Cell',
      label: 'Row',
      rect: { x: 0, y: 50, width: 100, height: 20 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 4,
      type: 'Cell',
      label: 'Row',
      rect: { x: 0, y: 0, width: 100, height: 20 },
      depth: 2,
      parentIndex: 1,
    },
  ]);
}

test('computeTargetEvidence: scrollRegion is the nearest scrollable ancestor local identity, viewportOrder is top-to-bottom within it', () => {
  const nodes = scrollableListFixture();
  const winner = nodes[2]!; // rect y:100 -> should be last (index 2) in top-to-bottom order
  const evidence = computeTargetEvidence({ node: winner, preActionNodes: nodes });
  assert.ok(evidence);
  assert.deepEqual(evidence.scrollRegion, { role: 'scrollview', id: 'editor-scroll' });
  // rows are at y=0,50,100 -> the y:100 row is ordinal 2 (0-based) top-to-bottom
  assert.equal(evidence.viewportOrder, 2);
  assert.equal(evidence.verification, 'verified');
});

test('computeTargetEvidence: a stable scroll-region ID takes precedence over a changed label', () => {
  const recordedNodes = scrollableListFixture();
  recordedNodes[1]!.label = 'Inbox';
  const recorded = computeTargetEvidence({
    node: recordedNodes[2]!,
    preActionNodes: recordedNodes,
  });

  const currentNodes = scrollableListFixture();
  currentNodes[1]!.label = 'Messages';
  const current = computeTargetEvidence({ node: currentNodes[2]!, preActionNodes: currentNodes });

  assert.ok(recorded);
  assert.ok(current);
  assert.deepEqual(recorded.scrollRegion, { role: 'scrollview', id: 'editor-scroll' });
  assert.deepEqual(current.scrollRegion, recorded.scrollRegion);
});

// ---------------------------------------------------------------------------
// Duplicate identity resolved by sibling / viewportOrder, still verified
// (decision 3's self-check succeeds by construction whenever the capture
// supplies the needed structural data).
// ---------------------------------------------------------------------------

test('computeTargetEvidence: duplicate identity across two parents is still verified via the sibling ordinal', () => {
  const nodes = toSnapshotNodes([
    { index: 0, type: 'Window', depth: 0 },
    { index: 1, type: 'Row', depth: 1, parentIndex: 0 },
    {
      index: 2,
      type: 'Button',
      label: 'Go back',
      rect: { x: 0, y: 0, width: 40, height: 20 },
      depth: 2,
      parentIndex: 1,
    },
    { index: 3, type: 'Row', depth: 1, parentIndex: 0 },
    {
      index: 4,
      type: 'Button',
      label: 'Go back',
      rect: { x: 0, y: 200, width: 40, height: 20 },
      depth: 2,
      parentIndex: 3,
    },
  ]);
  const winner = nodes[4]!; // the second "Go back" button, under the second Row
  const evidence = computeTargetEvidence({ node: winner, preActionNodes: nodes });
  assert.ok(evidence);
  assert.equal(evidence.id, undefined);
  assert.equal(evidence.role, 'button');
  assert.equal(evidence.label, 'Go back');
  // Both buttons are child index 0 of their own (identical, unlabeled) Row —
  // ancestry alone does not disambiguate them, and sibling is identical (0)
  // for both. Only document-order-based viewportOrder within the (no
  // scroll-region) partition can isolate the winner.
  assert.equal(evidence.sibling, 0);
  assert.equal(evidence.verification, 'verified');
});

// ---------------------------------------------------------------------------
// Writer-parser invariant: max-size (256-byte) labels x K=8 ancestry reduces
// rather than rejecting its own output.
// ---------------------------------------------------------------------------

test('computeTargetEvidence: max-size labels across K=8 ancestors reduce ancestry to fit 4 KiB, and the writer never rejects its own output', () => {
  const maxLabel = 'x'.repeat(TARGET_ANNOTATION_MAX_FIELD_BYTES);
  const raw: RawSnapshotNode[] = [];
  // Build a deep chain of 9 ancestors (root .. depth 8) with BOTH role and
  // label maxed at 256 bytes, plus the winning leaf at depth 9. 8 such
  // entries alone exceed the 4 KiB payload cap, forcing root-side reduction.
  for (let depth = 0; depth < 9; depth += 1) {
    raw.push({
      index: depth,
      type: maxLabel,
      label: maxLabel,
      depth,
      parentIndex: depth > 0 ? depth - 1 : undefined,
    });
  }
  raw.push({
    index: 9,
    type: 'Button',
    label: maxLabel,
    identifier: maxLabel,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    depth: 9,
    parentIndex: 8,
  });
  const nodes = toSnapshotNodes(raw);
  const winner = nodes.at(-1)!;

  const evidence = computeTargetEvidence({ node: winner, preActionNodes: nodes });
  assert.ok(evidence);
  assert.ok(evidence.ancestry.length <= TARGET_ANNOTATION_MAX_ANCESTRY);
  assert.ok(
    evidence.ancestry.length < TARGET_ANNOTATION_MAX_ANCESTRY,
    'ancestry must have been reduced',
  );
  // Nearest-ancestor-first: the first (kept) entries are the leaf-side ones.
  assert.equal(evidence.ancestry[0]?.label, maxLabel);

  const json = serializeTargetAnnotationV1(evidence);
  assert.ok(utf8ByteLength(json) <= TARGET_ANNOTATION_MAX_PAYLOAD_BYTES);
  // The writer-parser invariant: the writer's own output must never be
  // rejected by its own parser.
  const reparsed = parseTargetAnnotationV1Payload(json);
  assert.deepEqual(reparsed, evidence);
});

test('computeTargetEvidence: a root node with no ancestors has empty ancestry and is still verified', () => {
  const nodes = toSnapshotNodes([
    {
      index: 0,
      type: 'Button',
      identifier: 'root-button',
      label: 'Root',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      depth: 0,
    },
  ]);
  const evidence = computeTargetEvidence({ node: nodes[0]!, preActionNodes: nodes });
  assert.ok(evidence);
  assert.deepEqual(evidence.ancestry, []);
  assert.equal(evidence.verification, 'verified');
});

// ---------------------------------------------------------------------------
// Fixture realism: a real-capture-shaped tree (react-navigation-style bottom
// tab bar) with undefined/false `hittable` and anonymous wrapper nodes — see
// test/integration/provider-scenarios/ios-world.ts (PR #1172 pattern).
// ---------------------------------------------------------------------------

function bottomTabsRealCaptureFixture(): SnapshotNode[] {
  return toSnapshotNodes([
    {
      index: 0,
      type: 'Application',
      label: 'React Navigation Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      enabled: true,
      hittable: true,
      depth: 0,
    },
    {
      index: 1,
      type: 'Window',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      enabled: true,
      hittable: true,
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      type: 'ScrollView',
      label: 'Contacts',
      rect: { x: 0, y: 116, width: 402, height: 675 },
      enabled: true,
      hittable: false,
      hiddenContentBelow: true,
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 3,
      type: 'StaticText',
      label: 'Marissa Castillo',
      rect: { x: 52, y: 132, width: 110, height: 17 },
      enabled: true,
      // Real captures commonly omit `hittable` entirely on plain text nodes
      // rather than reporting it `false` — anonymous, undefined-hittable.
      depth: 3,
      parentIndex: 2,
    },
    {
      index: 4,
      // Anonymous wrapper: no identifier/label of its own — a real shape
      // this ADR's ancestry entries must tolerate (`role` present, `label`
      // omitted).
      type: 'Other',
      rect: { x: 0, y: 791, width: 402, height: 83 },
      enabled: true,
      hittable: false,
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 5,
      type: 'Button',
      label: 'Article, unselected',
      identifier: 'article',
      rect: { x: 0, y: 791, width: 101, height: 49 },
      enabled: true,
      hittable: false,
      depth: 3,
      parentIndex: 4,
    },
    {
      index: 6,
      type: 'Button',
      label: 'Chat, unselected',
      identifier: 'chat',
      rect: { x: 101, y: 791, width: 100, height: 49 },
      enabled: true,
      hittable: false,
      depth: 3,
      parentIndex: 4,
    },
  ]);
}

test('computeTargetEvidence: real-capture-shaped tree (undefined hittable, anonymous wrapper ancestor)', () => {
  const nodes = bottomTabsRealCaptureFixture();
  const winner = findByLabel(nodes, 'Article, unselected');
  const evidence = computeTargetEvidence({ node: winner, preActionNodes: nodes });
  assert.ok(evidence);
  assert.equal(evidence.id, 'article');
  assert.equal(evidence.role, 'button');
  // The anonymous "Other" wrapper ancestor carries a role but no label.
  assert.deepEqual(evidence.ancestry[0], { role: 'other' });
  assert.equal(evidence.ancestry[1]?.role, 'window');
  assert.equal(evidence.ancestry[2]?.role, 'application');
  assert.equal(evidence.scrollRegion, undefined); // tab bar sits outside the ScrollView
  assert.equal(evidence.sibling, 0); // first child of the "Other" tab-bar row
  assert.equal(evidence.verification, 'verified');

  const json = serializeTargetAnnotationV1(evidence);
  assert.deepEqual(parseTargetAnnotationV1Payload(json), evidence);
});

// ---------------------------------------------------------------------------
// Self-consistency: a node whose own id/label exceeds the 256-byte field cap
// must still match ITSELF during the identity-set scan. The recorded
// identity is truncated (writer-parser invariant); comparing an untruncated
// candidate against it would spuriously exclude the winner from its own
// identity set and produce a false 'unverifiable'.
// ---------------------------------------------------------------------------

test('computeTargetEvidence: a node with an over-cap id still matches itself and is verified', () => {
  const overCapId = 'save-'.repeat(100); // 500 bytes, well over the 256-byte field cap
  const nodes = toSnapshotNodes([
    {
      index: 0,
      type: 'Button',
      identifier: overCapId,
      label: 'Save',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      depth: 0,
    },
  ]);
  const evidence = computeTargetEvidence({ node: nodes[0]!, preActionNodes: nodes });
  assert.ok(evidence);
  assert.equal(evidence.id, overCapId.slice(0, TARGET_ANNOTATION_MAX_FIELD_BYTES));
  assert.equal(evidence.verification, 'verified');
});

// ---------------------------------------------------------------------------
// Worst-case verification sizing: "unverifiable" serializes 4 bytes longer
// than "verified". The reduction loop must size each candidate against the
// worst-case value so a fail-closed self-check downgrade can never push an
// already-accepted payload over the 4 KiB cap. The window is only 4 bytes
// wide, so sweep a tunable root-side label length across the boundary — some
// length in the sweep necessarily lands inside the window, where a
// placeholder-sized ("verified") check would accept a payload whose
// downgraded form overflows.
// ---------------------------------------------------------------------------

test('computeTargetEvidence: reduction sizes against the worst-case verification value across the 4 KiB boundary', () => {
  const maxField = 'x'.repeat(TARGET_ANNOTATION_MAX_FIELD_BYTES);

  const buildChain = (tunableLabelLength: number): SnapshotNode[] => {
    const raw: RawSnapshotNode[] = [];
    // Root (index 0) .. leaf's parent (index 7): 8 ancestors total (K=8).
    // Root-side entries are dropped first, so the tunable label sits at the
    // root to sweep total payload size in 1-byte steps.
    raw.push({ index: 0, type: 'Window', label: 'w'.repeat(tunableLabelLength), depth: 0 });
    raw.push({ index: 1, type: 'View', label: 'v', depth: 1, parentIndex: 0 });
    for (let depth = 2; depth < 8; depth += 1) {
      raw.push({ index: depth, type: maxField, label: maxField, depth, parentIndex: depth - 1 });
    }
    raw.push({
      index: 8,
      type: maxField,
      label: maxField,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      depth: 8,
      parentIndex: 7,
    });
    return toSnapshotNodes(raw);
  };

  let sawFullAncestry = false;
  let sawReducedAncestry = false;
  for (let tunable = 0; tunable <= TARGET_ANNOTATION_MAX_FIELD_BYTES; tunable += 1) {
    const nodes = buildChain(tunable);
    const evidence = computeTargetEvidence({ node: nodes.at(-1)!, preActionNodes: nodes });
    assert.ok(evidence);
    if (evidence.ancestry.length === TARGET_ANNOTATION_MAX_ANCESTRY) sawFullAncestry = true;
    else sawReducedAncestry = true;
    // The emitted payload must fit even re-serialized with the longer
    // verification value — the invariant the worst-case sizing guarantees.
    const worstCase = serializeTargetAnnotationV1({ ...evidence, verification: 'unverifiable' });
    assert.ok(
      utf8ByteLength(worstCase) <= TARGET_ANNOTATION_MAX_PAYLOAD_BYTES,
      `worst-case payload overflows at tunable label length ${tunable}`,
    );
    // And the parser accepts the writer's actual output, as always.
    parseTargetAnnotationV1Payload(serializeTargetAnnotationV1(evidence));
  }
  // The sweep must actually cross the reduction boundary for the window to
  // have been exercised.
  assert.ok(sawFullAncestry, 'sweep never produced an unreduced payload — fixture too large');
  assert.ok(sawReducedAncestry, 'sweep never forced a reduction — fixture too small');
});

// ---------------------------------------------------------------------------
// Broken parent linkage is a capture anomaly (decision 3): fail closed to
// 'unverifiable', never 'verified' on structural data that cannot be trusted.
// ---------------------------------------------------------------------------

test('computeTargetEvidence: a dangling parentIndex records unverifiable, never verified', () => {
  const nodes = toSnapshotNodes([
    {
      index: 0,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      depth: 1,
      parentIndex: 42, // no node with index 42 exists
    },
  ]);
  const evidence = computeTargetEvidence({ node: nodes[0]!, preActionNodes: nodes });
  assert.ok(evidence);
  assert.equal(evidence.verification, 'unverifiable');
});

test('computeTargetEvidence: a parent cycle records unverifiable, never verified', () => {
  const nodes = toSnapshotNodes([
    { index: 0, type: 'View', depth: 0, parentIndex: 1 },
    { index: 1, type: 'View', depth: 1, parentIndex: 0 },
    {
      index: 2,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      depth: 2,
      parentIndex: 1,
    },
  ]);
  const evidence = computeTargetEvidence({ node: nodes[2]!, preActionNodes: nodes });
  assert.ok(evidence);
  assert.equal(evidence.verification, 'unverifiable');
});
