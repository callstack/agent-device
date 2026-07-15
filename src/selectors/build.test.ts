import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { buildNodes } from '../__tests__/test-utils/snapshot-builders.ts';
import { buildSelectorChainForNode } from './build.ts';

function findByLabel(nodes: SnapshotNode[], label: string): SnapshotNode {
  const found = nodes.find((node) => node.label === label);
  if (!found) throw new Error(`fixture missing node with label ${label}`);
  return found;
}

// ---------------------------------------------------------------------------
// #1269: a recorded id only leads the chain when it is unique in the
// record-time tree. `android:id/title` — a shared Android framework
// resource id present on every titled list row — is the measured repro
// shape; matchCount reflects how many nodes in `nodes` carry the id.
// ---------------------------------------------------------------------------

function androidSettingsListFixture(): SnapshotNode[] {
  return buildNodes([
    { index: 0, type: 'FrameLayout', depth: 0 },
    { index: 1, type: 'RecyclerView', depth: 1, parentIndex: 0 },
    // Each row is a label-less LinearLayout wrapper (real Android list shape)
    // whose title TextView shares the same framework resource id.
    { index: 2, type: 'LinearLayout', depth: 2, parentIndex: 1 },
    {
      index: 3,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Network & internet',
      rect: { x: 0, y: 100, width: 300, height: 48 },
      depth: 3,
      parentIndex: 2,
    },
    { index: 4, type: 'LinearLayout', depth: 2, parentIndex: 1 },
    {
      index: 5,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Connected devices',
      rect: { x: 0, y: 148, width: 300, height: 48 },
      depth: 3,
      parentIndex: 4,
    },
    { index: 6, type: 'LinearLayout', depth: 2, parentIndex: 1 },
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

test('buildSelectorChainForNode: a shared Android framework id (matchCount > 1) is demoted — chain leads with role+label, not id', () => {
  const nodes = androidSettingsListFixture();
  const row = findByLabel(nodes, 'Network & internet');
  const chain = buildSelectorChainForNode(row, 'android', { action: 'get', nodes });
  assert.deepEqual(chain, [
    'role="textview" label="Network & internet"',
    'label="Network & internet"',
  ]);
  assert.ok(
    !chain.some((entry) => entry.startsWith('id=')),
    'a non-unique id must never lead (or appear in) the recorded selector chain',
  );
});

test('buildSelectorChainForNode: an RN FlatList reusing one testID across rows (iOS/RN, matchCount > 1) is demoted the same way', () => {
  // RN's common FlatList antipattern: `renderItem` assigns the SAME testID to
  // every row. On iOS this surfaces as one accessibility identifier shared by
  // every cell — the same non-selective-id class as the Android framework
  // resource id above, reproduced on a different platform to prove the rule
  // is capture-time uniqueness, not an `android:id/*` namespace check.
  const nodes = buildNodes([
    { index: 0, type: 'Application', depth: 0 },
    { index: 1, type: 'ScrollView', identifier: 'contacts-list', depth: 1, parentIndex: 0 },
    {
      index: 2,
      type: 'Cell',
      identifier: 'contact-row',
      label: 'Ada Lovelace',
      rect: { x: 0, y: 0, width: 320, height: 60 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 3,
      type: 'Cell',
      identifier: 'contact-row',
      label: 'Grace Hopper',
      rect: { x: 0, y: 60, width: 320, height: 60 },
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 4,
      type: 'Cell',
      identifier: 'contact-row',
      label: 'Katherine Johnson',
      rect: { x: 0, y: 120, width: 320, height: 60 },
      depth: 2,
      parentIndex: 1,
    },
  ]);
  const row = findByLabel(nodes, 'Grace Hopper');
  const chain = buildSelectorChainForNode(row, 'ios', { action: 'get', nodes });
  assert.deepEqual(chain, ['role="cell" label="Grace Hopper"', 'label="Grace Hopper"']);
  assert.ok(!chain.some((entry) => entry.startsWith('id=')));
});

test('buildSelectorChainForNode: a unique id still leads the chain (existing already-clean behavior is preserved)', () => {
  const nodes = buildNodes([
    { index: 0, type: 'Window', depth: 0 },
    {
      index: 1,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 10, y: 10, width: 40, height: 20 },
      depth: 1,
      parentIndex: 0,
    },
  ]);
  const node = findByLabel(nodes, 'Save');
  const chain = buildSelectorChainForNode(node, 'ios', { action: 'get', nodes });
  assert.deepEqual(chain, ['id="save"', 'role="button" label="Save"', 'label="Save"']);
});

test('buildSelectorChainForNode: without a record-time tree, an id is trusted as-is (back-compat default)', () => {
  const nodes = buildNodes([
    {
      index: 0,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 10, y: 10, width: 40, height: 20 },
      depth: 0,
    },
  ]);
  const chain = buildSelectorChainForNode(nodes[0]!, 'ios', { action: 'get' });
  assert.deepEqual(chain, ['id="save"', 'role="button" label="Save"', 'label="Save"']);
});
