import { test } from 'vitest';
import assert from 'node:assert/strict';
import { captureScrollEdgeState } from './scroll-edge-state.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { capture, scopeFor, scrollNode, windowRoot } from './scroll-edge-state-fixtures.ts';

// ---------------------------------------------------------------------------
// buildScrollContainerScope / isUsefulScope
// ---------------------------------------------------------------------------

test('buildScrollContainerScope: identifier is preferred over label', async () => {
  assert.equal(await scopeFor({ identifier: 'feed', label: 'Feed list' }), 'feed');
});

test('buildScrollContainerScope: label is used when identifier is empty', async () => {
  assert.equal(await scopeFor({ identifier: '', label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: label is used when identifier is a boolean-like string', async () => {
  assert.equal(await scopeFor({ identifier: 'TRUE', label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: label is used when identifier is pure digits', async () => {
  assert.equal(await scopeFor({ identifier: '12345', label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: label is used when identifier is a percentage', async () => {
  assert.equal(await scopeFor({ identifier: '45%', label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: label is used when identifier exceeds 80 characters', async () => {
  assert.equal(await scopeFor({ identifier: 'x'.repeat(81), label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: value is never used as a fallback scope, even when identifier and label both fail', async () => {
  assert.equal(await scopeFor({ identifier: '123', label: '50%', value: 'Messages' }), undefined);
});

test('buildScrollContainerScope: undefined when identifier and label are both unusable', async () => {
  assert.equal(await scopeFor({ identifier: 'false', label: '100%', value: '999' }), undefined);
});

test('buildScrollContainerScope: undefined when none of the fields are set', async () => {
  assert.equal(await scopeFor({}), undefined);
});

test('buildScrollContainerScope: a normal label with parentheses and digits is a useful scope', async () => {
  assert.equal(await scopeFor({ label: 'Recents (12)' }), 'Recents (12)');
});

test('buildScrollContainerScope: a label that is exactly 80 characters is still useful', async () => {
  const eighty = 'a'.repeat(80);
  assert.equal(await scopeFor({ identifier: '', label: eighty }), eighty);
});

test('buildScrollContainerScope: whitespace-only identifier is trimmed to empty and falls through to label', async () => {
  // Untrimmed, two spaces would have length > 0 and match none of the reject
  // patterns, so it would incorrectly pass isUsefulScope as-is.
  assert.equal(await scopeFor({ identifier: '  ', label: 'Feed list' }), 'Feed list');
});

test('buildScrollContainerScope: surrounding whitespace on an otherwise-useful identifier is trimmed off', async () => {
  assert.equal(await scopeFor({ identifier: '  feed  ' }), 'feed');
});

test('isUsefulScope: the true/false and digit/percentage checks require a full-string match, not a prefix or suffix match', async () => {
  // Each value below deliberately starts or ends with a reject pattern's
  // literal text while not equaling it exactly, so it must be ACCEPTED as a
  // useful scope. A reject regex missing its ^ or $ anchor would wrongly
  // match these as prefixes/suffixes and reject them instead.
  assert.equal(await scopeFor({ identifier: 'trueish' }), 'trueish');
  assert.equal(await scopeFor({ identifier: 'istrue' }), 'istrue');
  assert.equal(await scopeFor({ identifier: '123abc' }), '123abc');
  assert.equal(await scopeFor({ identifier: 'abc123' }), 'abc123');
  assert.equal(await scopeFor({ identifier: '50%off' }), '50%off');
  assert.equal(await scopeFor({ identifier: 'off50%' }), 'off50%');
});

test('isUniqueScopeValue: an unrelated sibling with its own distinct, non-matching label does not make the scope ambiguous', async () => {
  // 'Toolbar' is a real, truthy label — but it does not CONTAIN 'feed list', so
  // a correct substring match excludes it. A weakened check that only asks
  // "does this node have any truthy identifier/label/value" (dropping the
  // substring comparison entirely) would wrongly count it as a second match
  // and reject 'Feed list' as ambiguous.
  const nodes: SnapshotNode[] = [
    windowRoot(),
    scrollNode(1, { label: 'Feed list', hiddenContentBelow: true }),
    {
      ref: 'e3',
      index: 2,
      parentIndex: 0,
      type: 'Toolbar',
      label: 'Toolbar',
      rect: { x: 0, y: 0, width: 400, height: 100 },
    },
  ];
  const state = await capture(nodes, 'bottom');
  assert.equal(state.scope, 'Feed list');
});

// ---------------------------------------------------------------------------
// isUniqueScopeValue: uniqueness across colliding sibling values
// ---------------------------------------------------------------------------

test('duplicate scroll-container labels do not scope edge verification to a child', async () => {
  const scopes: Array<string | undefined> = [];
  const nodes: SnapshotNode[] = [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      label: 'Automation lab',
      hiddenContentAbove: true,
      rect: { x: 18, y: 178, width: 366, height: 662 },
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'StaticText',
      label: 'Automation lab',
      rect: { x: 18, y: -344, width: 311, height: 36 },
    },
  ];

  const state = await captureScrollEdgeState({
    edge: 'top',
    captureNodes: async (scope) => {
      scopes.push(scope);
      return nodes;
    },
  });

  assert.equal(state.canScroll, true);
  assert.equal(state.scope, undefined);
  assert.deepEqual(scopes, [undefined]);
});

for (const collision of ['Automation lab details', 'AUTOMATION LAB']) {
  test(`native-style scope collision does not select ${JSON.stringify(collision)}`, async () => {
    const nodes: SnapshotNode[] = [
      {
        index: 1,
        ref: 'e1',
        type: 'ScrollView',
        label: 'Automation lab',
        hiddenContentAbove: true,
        rect: { x: 18, y: 178, width: 366, height: 662 },
      },
      {
        index: 2,
        ref: 'e2',
        parentIndex: 1,
        type: 'StaticText',
        label: collision,
        rect: { x: 18, y: -344, width: 311, height: 36 },
      },
    ];

    const state = await captureScrollEdgeState({
      edge: 'top',
      captureNodes: async () => nodes,
    });

    assert.equal(state.scope, undefined);
  });
}

test('value collision does not scope edge verification to an ambiguous subtree', async () => {
  const nodes: SnapshotNode[] = [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      label: 'Automation lab',
      hiddenContentAbove: true,
      rect: { x: 18, y: 178, width: 366, height: 662 },
    },
    {
      index: 2,
      ref: 'e2',
      type: 'Other',
      value: 'Automation lab ready',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
  ];

  const state = await captureScrollEdgeState({
    edge: 'top',
    captureNodes: async () => nodes,
  });

  assert.equal(state.scope, undefined);
});
