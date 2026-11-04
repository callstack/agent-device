import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotAddressableNode } from '@agent-device/kernel/snapshot';
import { resolveFocusTarget } from './node-touch-point.ts';

const ROOT: SnapshotAddressableNode = {
  index: 0,
  ref: 'e1',
  type: 'Application',
  rect: { x: 0, y: 0, width: 400, height: 800 },
};

function child(
  index: number,
  overrides: Partial<SnapshotAddressableNode>,
): SnapshotAddressableNode {
  return {
    index,
    ref: `e${index + 1}`,
    parentIndex: 0,
    rect: { x: 20, y: 100 + index * 60, width: 360, height: 40 },
    hittable: true,
    ...overrides,
  };
}

function resolve(
  located: SnapshotAddressableNode,
  resolved: SnapshotAddressableNode,
  nodes: SnapshotAddressableNode[],
) {
  return resolveFocusTarget({ located, resolved, nodes: [ROOT, ...nodes], platform: 'apple' });
}

test('an untyped child is not a text field, so it neither takes the focus nor counts', () => {
  const card = child(1, { type: 'Other', rect: { x: 0, y: 0, width: 400, height: 400 } });
  const untyped = [child(2, { parentIndex: 1 }), child(3, { parentIndex: 1 })];
  const target = resolve(card, card, [card, ...untyped]);
  assert.deepEqual(target, { kind: 'target', node: card });
});

test('a published editable fact makes an unrecognized type a text field', () => {
  const card = child(1, { type: 'Other', rect: { x: 0, y: 0, width: 400, height: 400 } });
  const editor = child(2, { parentIndex: 1, type: 'RichEditor', editable: true });
  assert.deepEqual(resolve(card, card, [card, editor]), { kind: 'target', node: editor });
});

test('a published editable fact keeps a read-only field out of the count', () => {
  const card = child(1, { type: 'Other', rect: { x: 0, y: 0, width: 400, height: 400 } });
  const readOnly = child(2, { parentIndex: 1, type: 'TextField', editable: false });
  const field = child(3, { parentIndex: 1, type: 'TextField' });
  assert.deepEqual(resolve(card, card, [card, readOnly, field]), { kind: 'target', node: field });
});

test('a matched field stays the target whatever it contains', () => {
  const host = child(1, { type: 'TextArea', rect: { x: 0, y: 0, width: 400, height: 400 } });
  const inner = [
    child(2, { parentIndex: 1, type: 'TextField' }),
    child(3, { parentIndex: 1, type: 'TextField' }),
  ];
  assert.deepEqual(resolve(host, host, [host, ...inner]), { kind: 'target', node: host });
});

test('fields under different controls each count, and nested ones count as their outermost', () => {
  const form = child(1, { type: 'Other', rect: { x: 0, y: 0, width: 400, height: 400 } });
  const search = child(2, { parentIndex: 1, type: 'SearchField' });
  const hosted = child(3, { parentIndex: 2, type: 'TextField' });
  const other = child(4, { parentIndex: 1, type: 'TextField' });
  assert.deepEqual(resolve(form, form, [form, search, hosted, other]), {
    kind: 'several-fields',
    fields: [search, other],
  });
});

test('android reads its own field types', () => {
  const row = child(1, {
    type: 'android.widget.LinearLayout',
    rect: { x: 0, y: 0, width: 400, height: 400 },
  });
  const field = child(2, { parentIndex: 1, type: 'android.widget.EditText' });
  const target = resolveFocusTarget({
    located: row,
    resolved: row,
    nodes: [ROOT, row, field],
    platform: 'android',
  });
  assert.deepEqual(target, { kind: 'target', node: field });
});
