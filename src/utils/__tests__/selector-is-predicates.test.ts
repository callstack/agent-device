import assert from 'node:assert/strict';
import { test } from 'vitest';
import { evaluateIsPredicate } from '../selector-is-predicates.ts';
import type { SnapshotNode } from '../../kernel/snapshot.ts';

test('visible predicate treats zero-height hittable Android nodes as hidden', () => {
  const nodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      ref: 'e1',
      parentIndex: 0,
      type: 'android.widget.Button',
      identifier: 'tab-4',
      label: 'Tab 4',
      rect: { x: 0, y: 800, width: 100, height: 0 },
      hittable: true,
    },
  ];

  const result = evaluateIsPredicate({
    predicate: 'visible',
    node: nodes[1]!,
    nodes,
    platform: 'android',
  });

  assert.equal(result.pass, false);
});

test('visible predicate treats rectless hittable Android nodes as hidden', () => {
  const nodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      ref: 'e1',
      type: 'android.widget.Button',
      label: 'Library',
      hittable: true,
    },
  ];

  const result = evaluateIsPredicate({
    predicate: 'visible',
    node: nodes[1]!,
    nodes,
    platform: 'android',
  });

  assert.equal(result.pass, false);
});

test('visible predicate uses visible Android ancestor geometry for rectless text', () => {
  const nodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      ref: 'e1',
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Library',
      rect: { x: 20, y: 100, width: 160, height: 80 },
      hittable: true,
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'android.widget.TextView',
      label: 'Library',
      hittable: false,
    },
  ];

  const result = evaluateIsPredicate({
    predicate: 'visible',
    node: nodes[2]!,
    nodes,
    platform: 'android',
  });

  assert.equal(result.pass, true);
});

test('visible predicate treats Android nodes hidden from users as hidden', () => {
  const nodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.Button',
      label: 'Drawer item',
      rect: { x: 0, y: 0, width: 200, height: 80 },
      hittable: true,
      visibleToUser: false,
    },
  ];

  const result = evaluateIsPredicate({
    predicate: 'visible',
    node: nodes[0]!,
    nodes,
    platform: 'android',
  });

  assert.equal(result.pass, false);
});

test('visible predicate does not use non-hittable Android layout ancestors for rectless text', () => {
  const nodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 1080, height: 2340 },
    },
    {
      index: 1,
      ref: 'e1',
      parentIndex: 0,
      type: 'android.view.ViewGroup',
      rect: { x: 0, y: 0, width: 816, height: 2340 },
      hittable: false,
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'Albums',
      hittable: true,
    },
    {
      index: 3,
      ref: 'e3',
      parentIndex: 2,
      type: 'android.widget.TextView',
      label: 'Albums',
      value: 'Albums',
    },
  ];

  const result = evaluateIsPredicate({
    predicate: 'visible',
    node: nodes[3]!,
    nodes,
    platform: 'android',
  });

  assert.equal(result.pass, false);
});
