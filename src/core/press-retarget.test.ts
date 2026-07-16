import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { buildNodes } from '../__tests__/test-utils/snapshot-builders.ts';
import { computeTargetEvidence } from '../daemon/session-target-evidence.ts';
import { buildSelectorChainForNode } from '../selectors/build.ts';
import { parseSelectorChain, resolveSelectorChain } from '../selectors/index.ts';
import { readNodeLocalIdentity } from '../replay/target-identity-node.ts';
import { resolvePressRecordingTarget } from './press-retarget.ts';

function findByLabel(nodes: SnapshotNode[], label: string): SnapshotNode {
  const found = nodes.find((node) => node.label === label);
  if (!found) throw new Error(`fixture missing node with label ${label}`);
  return found;
}

// ---------------------------------------------------------------------------
// #1280: an Android list row's clickable container is a label-less
// LinearLayout — no id, no label, no value/text (rule 1). Its title lives on
// a child TextView sharing `android:id/title` across every row (the same
// shape #1272 demotes for the get class), so the descendant is itself
// id-demoted but selective via role+label.
// ---------------------------------------------------------------------------

function androidRowsFixture(): SnapshotNode[] {
  return buildNodes([
    { index: 0, type: 'FrameLayout', depth: 0 },
    { index: 1, type: 'RecyclerView', depth: 1, parentIndex: 0 },
    {
      index: 2,
      type: 'LinearLayout',
      rect: { x: 0, y: 100, width: 300, height: 48 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 3,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Network & internet',
      rect: { x: 0, y: 100, width: 300, height: 48 },
      depth: 3,
      parentIndex: 2,
    },
    {
      index: 4,
      type: 'LinearLayout',
      rect: { x: 0, y: 148, width: 300, height: 48 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 5,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Connected devices',
      rect: { x: 0, y: 148, width: 300, height: 48 },
      depth: 3,
      parentIndex: 4,
    },
    {
      index: 6,
      type: 'LinearLayout',
      rect: { x: 0, y: 196, width: 300, height: 48 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 7,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Apps',
      rect: { x: 0, y: 196, width: 300, height: 48 },
      depth: 3,
      parentIndex: 6,
    },
  ]);
}

function findRowContainer(nodes: SnapshotNode[], rowLabel: string): SnapshotNode {
  const title = findByLabel(nodes, rowLabel);
  const container = nodes.find((node) => node.index === title.parentIndex);
  if (!container) throw new Error(`fixture missing container for row ${rowLabel}`);
  return container;
}

test('resolvePressRecordingTarget: an identity-empty Android row container retargets to its labeled title descendant', () => {
  const nodes = androidRowsFixture();
  const container = findRowContainer(nodes, 'Connected devices');
  assert.equal(container.type, 'LinearLayout');
  assert.equal(container.identifier, undefined);
  assert.equal(container.label, undefined);

  const recorded = resolvePressRecordingTarget(container, nodes);
  assert.equal(recorded.ref, findByLabel(nodes, 'Connected devices').ref);
});

test('resolvePressRecordingTarget: the retargeted descendant records with its own shared id demoted (#1272), chain = role+label', () => {
  const nodes = androidRowsFixture();
  const container = findRowContainer(nodes, 'Connected devices');
  const recorded = resolvePressRecordingTarget(container, nodes);

  const evidence = computeTargetEvidence({ node: recorded, preActionNodes: nodes });
  assert.ok(evidence);
  assert.equal(
    evidence.id,
    undefined,
    'the shared android:id/title must not be recorded as identity',
  );
  assert.equal(evidence.role, 'textview');
  assert.equal(evidence.label, 'Connected devices');
  assert.equal(evidence.verification, 'verified');

  const chain = buildSelectorChainForNode(recorded, 'android', { action: 'click', nodes });
  assert.ok(!chain.some((entry) => entry.startsWith('id=')));
  assert.deepEqual(chain, [
    'role="textview" label="Connected devices"',
    'label="Connected devices"',
  ]);
});

test('resolvePressRecordingTarget: a node that already carries its own identity is returned unchanged (not identity-empty)', () => {
  const nodes = androidRowsFixture();
  const title = findByLabel(nodes, 'Apps');
  const recorded = resolvePressRecordingTarget(title, nodes);
  assert.equal(recorded.ref, title.ref);
});

// ---------------------------------------------------------------------------
// Guard (rule 3): a row whose subtree contains another interactive/hittable
// descendant (a trailing Switch is the measured risk shape) must NOT
// retarget — a tap at the label's center vs the container's center could
// land on a different control. Records the container exactly as today.
// ---------------------------------------------------------------------------

function androidRowWithSwitchFixture(): SnapshotNode[] {
  return buildNodes([
    { index: 0, type: 'FrameLayout', depth: 0 },
    {
      index: 1,
      type: 'LinearLayout',
      rect: { x: 0, y: 0, width: 300, height: 48 },
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      type: 'TextView',
      label: 'Wi-Fi',
      rect: { x: 0, y: 0, width: 200, height: 48 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 3,
      type: 'Switch',
      hittable: true,
      rect: { x: 220, y: 0, width: 60, height: 48 },
      depth: 2,
      parentIndex: 1,
    },
  ]);
}

test('resolvePressRecordingTarget: a row with a trailing hittable Switch does NOT retarget', () => {
  const nodes = androidRowWithSwitchFixture();
  const container = nodes.find((node) => node.type === 'LinearLayout')!;
  assert.equal(container.identifier, undefined);
  assert.equal(container.label, undefined);

  const recorded = resolvePressRecordingTarget(container, nodes);
  assert.equal(
    recorded.ref,
    container.ref,
    'guard must block retargeting past a competing interactive descendant',
  );
});

test('resolvePressRecordingTarget: a role-typed (non-hittable-flagged) Checkbox descendant still blocks via its type', () => {
  const nodes = buildNodes([
    { index: 0, type: 'LinearLayout', rect: { x: 0, y: 0, width: 300, height: 48 }, depth: 0 },
    {
      index: 1,
      type: 'TextView',
      label: 'Enable notifications',
      rect: { x: 0, y: 0, width: 200, height: 48 },
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      // Real captures commonly omit `hittable` on a Checkbox rather than
      // reporting it explicitly; the type-fragment fallback must still catch it.
      type: 'CheckBox',
      rect: { x: 220, y: 0, width: 40, height: 48 },
      depth: 1,
      parentIndex: 0,
    },
  ]);
  const container = nodes[0]!;
  const recorded = resolvePressRecordingTarget(container, nodes);
  assert.equal(recorded.ref, container.ref);
});

// ---------------------------------------------------------------------------
// iOS/RN parity: the rule is platform-agnostic. A FlatList `Cell` row is
// label-less with a shared testID (the #1272 measured RN shape) and a
// labeled `StaticText` child.
// ---------------------------------------------------------------------------

// Mirrors the Android LinearLayout wrapper shape (#1280's core case: no id
// AND no label on the container itself), not #1272's shared-testID class —
// that cross-cutting demotion case is exercised separately by
// `androidRowsFixture` above.
function rnFlatListRowsFixture(): SnapshotNode[] {
  return buildNodes([
    { index: 0, type: 'Application', depth: 0 },
    { index: 1, type: 'ScrollView', identifier: 'contacts-list', depth: 1, parentIndex: 0 },
    {
      index: 2,
      type: 'Cell',
      rect: { x: 0, y: 0, width: 320, height: 60 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 3,
      type: 'StaticText',
      label: 'Ada Lovelace',
      rect: { x: 0, y: 0, width: 320, height: 60 },
      depth: 3,
      parentIndex: 2,
    },
    {
      index: 4,
      type: 'Cell',
      rect: { x: 0, y: 60, width: 320, height: 60 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 5,
      type: 'StaticText',
      label: 'Grace Hopper',
      rect: { x: 0, y: 60, width: 320, height: 60 },
      depth: 3,
      parentIndex: 4,
    },
  ]);
}

test('resolvePressRecordingTarget: RN FlatList Cell row (iOS) retargets to its labeled StaticText child the same way', () => {
  const nodes = rnFlatListRowsFixture();
  const container = nodes.find((node) => node.index === 4)!; // the "Grace Hopper" row's Cell
  assert.equal(container.label, undefined);

  const recorded = resolvePressRecordingTarget(container, nodes);
  assert.equal(recorded.ref, findByLabel(nodes, 'Grace Hopper').ref);

  const evidence = computeTargetEvidence({ node: recorded, preActionNodes: nodes });
  assert.ok(evidence);
  assert.equal(evidence.id, undefined);
  assert.equal(evidence.role, 'statictext');
  assert.equal(evidence.label, 'Grace Hopper');
});

// ---------------------------------------------------------------------------
// Cross-invariant: whatever `resolvePressRecordingTarget` returns is the
// SAME node both writers key off — the chain resolves back to it uniquely,
// and the evidence self-check verifies against it. Covers all three shapes:
// retargeted, guard-blocked, and an already-labeled normal target.
// ---------------------------------------------------------------------------

function assertChainAndEvidenceAgreeOnRecordedNode(params: {
  nodes: SnapshotNode[];
  input: SnapshotNode;
  platform: 'android' | 'ios';
}): void {
  const { nodes, input, platform } = params;
  const recordedNode = resolvePressRecordingTarget(input, nodes);

  const evidence = computeTargetEvidence({ node: recordedNode, preActionNodes: nodes });
  assert.ok(evidence, 'evidence must be computed for the recorded node');
  assert.equal(evidence.verification, 'verified');
  assert.equal(evidence.role, readNodeLocalIdentity(recordedNode).role);

  const chain = buildSelectorChainForNode(recordedNode, platform, { action: 'click', nodes });
  const resolved = resolveSelectorChain(nodes, parseSelectorChain(chain.join(' || ')), {
    platform,
    requireRect: true,
    requireUnique: true,
  });
  assert.ok(resolved, `chain ${JSON.stringify(chain)} failed to resolve uniquely`);
  assert.equal(
    resolved.node.ref,
    recordedNode.ref,
    'the recorded chain must resolve back to the exact node evidence was computed for',
  );
}

test('#1280 cross-invariant: chain and evidence agree on the recorded node — retargeted, guard-blocked, and normal cases', () => {
  // Retargeted: the container is identity-empty and the guard passes.
  const retargetedNodes = androidRowsFixture();
  assertChainAndEvidenceAgreeOnRecordedNode({
    nodes: retargetedNodes,
    input: findRowContainer(retargetedNodes, 'Connected devices'),
    platform: 'android',
  });

  // Guard-blocked: a trailing Switch descendant refuses the retarget, so the
  // recorded node stays the container itself.
  const guardBlockedNodes = androidRowWithSwitchFixture();
  const guardBlockedContainer = guardBlockedNodes.find((node) => node.type === 'LinearLayout')!;
  assertChainAndEvidenceAgreeOnRecordedNode({
    nodes: guardBlockedNodes,
    input: guardBlockedContainer,
    platform: 'android',
  });

  // Normal: the resolved winner already carries its own label — not
  // identity-empty, so resolvePressRecordingTarget is a no-op.
  const normalNodes = androidRowsFixture();
  assertChainAndEvidenceAgreeOnRecordedNode({
    nodes: normalNodes,
    input: findByLabel(normalNodes, 'Apps'),
    platform: 'android',
  });
});

// ---------------------------------------------------------------------------
// P2a (#1280 re-review): a container carrying its OWN duplicated id must not
// bypass retargeting. The id is demoted for non-uniqueness (#1269), so it
// does not survive into identity — and the text probe must consume the same
// DEMOTED view rather than resurrecting the raw identifier via
// extractNodeText's fallback.
// ---------------------------------------------------------------------------

function duplicatedContainerIdFixture(): SnapshotNode[] {
  return buildNodes([
    { index: 0, type: 'RecyclerView', depth: 0 },
    {
      index: 1,
      type: 'LinearLayout',
      identifier: 'com.example:id/row_container',
      rect: { x: 0, y: 100, width: 300, height: 48 },
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      type: 'TextView',
      label: 'Network & internet',
      rect: { x: 0, y: 100, width: 300, height: 48 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 3,
      type: 'LinearLayout',
      identifier: 'com.example:id/row_container',
      rect: { x: 0, y: 148, width: 300, height: 48 },
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 4,
      type: 'TextView',
      label: 'Connected devices',
      rect: { x: 0, y: 148, width: 300, height: 48 },
      depth: 2,
      parentIndex: 3,
    },
  ]);
}

test('resolvePressRecordingTarget P2a: a container whose own duplicated id was demoted still retargets (no raw-identifier bypass)', () => {
  const nodes = duplicatedContainerIdFixture();
  const container = nodes.find(
    (node) => node.index === 3 && node.identifier === 'com.example:id/row_container',
  )!;
  const recorded = resolvePressRecordingTarget(container, nodes);
  assert.equal(recorded.ref, findByLabel(nodes, 'Connected devices').ref);
});

test('resolvePressRecordingTarget P2a contrast: a container with a UNIQUE id keeps its identity and does not retarget', () => {
  const nodes = duplicatedContainerIdFixture();
  // Make the first container's id unique: it survives demotion, so the
  // container is identity-bearing and records as itself.
  const container = nodes.find((node) => node.index === 1)!;
  container.identifier = 'com.example:id/unique_row';
  const recorded = resolvePressRecordingTarget(container, nodes);
  assert.equal(recorded.ref, container.ref);
});

// ---------------------------------------------------------------------------
// P2b (#1280 re-review): the guard is built from the canonical interactive
// classification (`isSemanticTouchTarget`, core/interaction-targeting.ts),
// not a parallel list — roles the old private fragment list missed must
// block. And a geometry condition: the selected descendant's rect center
// must lie INSIDE the container's rect, else the replay tap point is not
// provably within the original activation region — no retarget.
// ---------------------------------------------------------------------------

test('resolvePressRecordingTarget P2b: a nested Cell descendant (canonical role the old fragment list missed) blocks retargeting', () => {
  const nodes = buildNodes([
    {
      index: 0,
      type: 'LinearLayout',
      rect: { x: 0, y: 0, width: 300, height: 96 },
      depth: 0,
    },
    {
      index: 1,
      type: 'TextView',
      label: 'Recent items',
      rect: { x: 0, y: 0, width: 300, height: 48 },
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      // A nested Cell (canonical `SEMANTIC_TOUCH_ROLE_FRAGMENTS` member,
      // absent from the old private list) — an independently tappable row
      // inside the container's subtree.
      type: 'Cell',
      rect: { x: 0, y: 48, width: 300, height: 48 },
      depth: 1,
      parentIndex: 0,
    },
  ]);
  const container = nodes[0]!;
  const recorded = resolvePressRecordingTarget(container, nodes);
  assert.equal(recorded.ref, container.ref);
});

test('resolvePressRecordingTarget P2b: a labeled descendant whose rect center lies OUTSIDE the container rect blocks retargeting', () => {
  const nodes = buildNodes([
    {
      index: 0,
      type: 'LinearLayout',
      rect: { x: 0, y: 100, width: 300, height: 48 },
      depth: 0,
    },
    {
      index: 1,
      // Overflowing label: its rect center (150, 200) sits below the
      // container's rect (y 100..148) — a tap there is not provably inside
      // the recorded activation region.
      type: 'TextView',
      label: 'Overflowing title',
      rect: { x: 0, y: 176, width: 300, height: 48 },
      depth: 1,
      parentIndex: 0,
    },
  ]);
  const container = nodes[0]!;
  const recorded = resolvePressRecordingTarget(container, nodes);
  assert.equal(recorded.ref, container.ref);
});

test('resolvePressRecordingTarget P2b: a rect-less container blocks retargeting (geometry fails closed)', () => {
  const nodes = buildNodes([
    { index: 0, type: 'LinearLayout', depth: 0 },
    {
      index: 1,
      type: 'TextView',
      label: 'Connected devices',
      rect: { x: 0, y: 100, width: 300, height: 48 },
      depth: 1,
      parentIndex: 0,
    },
  ]);
  const container = nodes[0]!;
  const recorded = resolvePressRecordingTarget(container, nodes);
  assert.equal(recorded.ref, container.ref);
});
