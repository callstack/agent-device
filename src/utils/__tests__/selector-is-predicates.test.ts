import assert from 'node:assert/strict';
import { test } from 'vitest';
import { evaluateIsPredicate, normalizeIsPositionals } from '../selector-is-predicates.ts';
import type { SnapshotNode } from '../../kernel/snapshot.ts';

test('normalizeIsPositionals keeps canonical predicate-first arguments untouched', () => {
  assert.deepEqual(normalizeIsPositionals(['visible', 'text=Zzznope']), [
    'visible',
    'text=Zzznope',
  ]);
  assert.deepEqual(normalizeIsPositionals(['text', 'id=title', 'Welcome']), [
    'text',
    'id=title',
    'Welcome',
  ]);
  // Predicate-first wins even when the trailing token is also a predicate name: the
  // bare `hidden` here is the boolean selector term, not a competing predicate.
  assert.deepEqual(normalizeIsPositionals(['visible', 'hidden']), ['visible', 'hidden']);
});

test('normalizeIsPositionals rotates the selector-first form to predicate-first', () => {
  assert.deepEqual(normalizeIsPositionals(['text=Zzznope', 'visible']), [
    'visible',
    'text=Zzznope',
  ]);
  assert.deepEqual(normalizeIsPositionals(['id=title', 'text', 'Welcome']), [
    'text',
    'id=title',
    'Welcome',
  ]);
  // Boolean selector terms before the trailing predicate stay inside the selector.
  assert.deepEqual(normalizeIsPositionals(['text=Foo', 'visible=true', 'selected']), [
    'selected',
    'text=Foo',
    'visible=true',
  ]);
});

test('normalizeIsPositionals leaves unparseable arguments untouched', () => {
  assert.deepEqual(normalizeIsPositionals(['text=Zzznope', 'nope']), ['text=Zzznope', 'nope']);
  assert.deepEqual(normalizeIsPositionals(['text=Zzznope']), ['text=Zzznope']);
  // The token before `visible` is not a valid selector, so no rotation applies.
  assert.deepEqual(normalizeIsPositionals(['Some Label', 'visible']), ['Some Label', 'visible']);
  assert.deepEqual(normalizeIsPositionals([]), []);
});

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
