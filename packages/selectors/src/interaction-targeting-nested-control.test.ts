import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from './snapshot-geometry.fixtures.ts';
import { isNestedTouchControl } from './interaction-targeting.ts';

function node(index: number, type: string, label: string, rect: Rect): SnapshotNode {
  return { index, depth: 1, parentIndex: 0, type, label, rect, hittable: true };
}

const APP = node(0, 'Application', 'App', { x: 0, y: 0, width: 402, height: 874 });
const ROW = node(1, 'Cell', 'Avocado, 3 item', { x: 20, y: 425, width: 362, height: 82 });

function gateOf(nodes: SnapshotNode[], label: string): boolean {
  const { nodes: tree } = makeSnapshotState(nodes);
  const target = tree.find((candidate) => candidate.label === label);
  assert.ok(target, `fixture has no node labelled ${label}`);
  return isNestedTouchControl(tree, target);
}

test('a swipe action button inside its actionable row is gated', () => {
  const action = node(2, 'Button', 'Delete Avocado', { x: 294, y: 425, width: 88, height: 82 });

  assert.equal(gateOf([APP, action, ROW], 'Delete Avocado'), true);
});

test('the row itself, which holds the action, is not gated', () => {
  const action = node(2, 'Button', 'Delete Avocado', { x: 294, y: 425, width: 88, height: 82 });

  assert.equal(gateOf([APP, action, ROW], 'Avocado, 3 item'), false);
});

test('a top-level button beside the row is not gated', () => {
  const add = node(2, 'Button', 'add, Add item', { x: 20, y: 610, width: 362, height: 52 });

  assert.equal(gateOf([APP, ROW, add], 'add, Add item'), false);
});

test('a button inside a container that is not itself a touch target is not gated', () => {
  const scroll = node(1, 'ScrollView', 'List', { x: 0, y: 116, width: 402, height: 675 });
  const action = node(2, 'Button', 'Delete Avocado', { x: 294, y: 425, width: 88, height: 82 });

  assert.equal(gateOf([APP, scroll, action], 'Delete Avocado'), false);
});

test('a tab bar item inside its tab bar is not gated', () => {
  const tabBar = node(1, 'TabBar', 'Tab Bar', { x: 0, y: 791, width: 402, height: 83 });
  const tab = node(2, 'Button', 'Profile', { x: 243, y: 795, width: 100, height: 54 });

  assert.equal(gateOf([APP, tabBar, tab], 'Profile'), false);
});

test('a wrapper that reports the same rect as its control does not gate the control', () => {
  const wrapper = node(1, 'Button', 'Save', { x: 348, y: 429, width: 22, height: 22 });
  const control = node(2, 'Button', 'Save control', { x: 348.5, y: 429.4, width: 22, height: 22 });

  assert.equal(gateOf([APP, wrapper, control], 'Save control'), false);
});

test('a button that only overlaps a larger touch control is not gated', () => {
  const card = node(1, 'Button', 'Lemon Herb Rice', { x: 32, y: 427, width: 308, height: 90 });
  const save = node(2, 'Button', 'Save Lemon Herb Rice', { x: 348, y: 429, width: 22, height: 22 });

  assert.equal(gateOf([APP, card, save], 'Save Lemon Herb Rice'), false);
});
