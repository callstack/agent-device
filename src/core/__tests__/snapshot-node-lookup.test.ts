import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { findNodeByLabel, resolveRefLabel } from '../snapshot-node-lookup.ts';

test('findNodeByLabel matches label, value, and identifier case-insensitively', () => {
  const nodes = attachRefs([
    { index: 0, label: 'Account settings' },
    { index: 1, value: 'Visible value' },
    { index: 2, identifier: 'save-button' },
  ]);

  assert.equal(findNodeByLabel(nodes, 'SETTINGS')?.index, 0);
  assert.equal(findNodeByLabel(nodes, 'visible')?.index, 1);
  assert.equal(findNodeByLabel(nodes, 'SAVE-BUTTON')?.index, 2);
  assert.equal(findNodeByLabel(nodes, 'missing'), null);
});

test('resolveRefLabel falls back to the nearest meaningful visible label', () => {
  const nodes = attachRefs([
    {
      index: 0,
      label: 'Continue',
      rect: { x: 0, y: 0, width: 100, height: 40 },
    },
    {
      index: 1,
      label: 'true',
      rect: { x: 0, y: 45, width: 100, height: 40 },
    },
  ]);

  assert.equal(resolveRefLabel(nodes[1]!, nodes), 'Continue');
});
