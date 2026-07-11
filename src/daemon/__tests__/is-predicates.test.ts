import { test } from 'vitest';
import assert from 'node:assert/strict';
import { evaluateIsPredicate } from '../../selectors/predicates.ts';

const viewportNode = {
  ref: 'e1',
  index: 0,
  type: 'XCUIElementTypeApplication',
  label: 'Demo App',
  rect: { x: 0, y: 0, width: 390, height: 844 },
};

const baseNode = {
  ref: 'e2',
  index: 1,
  parentIndex: 0,
  type: 'XCUIElementTypeTextField',
  label: 'Email',
  value: '',
  identifier: 'login_email',
  rect: { x: 0, y: 0, width: 100, height: 40 },
  enabled: true,
  hittable: true,
};

test('evaluateIsPredicate visible and hidden', () => {
  const nodes = [viewportNode, baseNode];
  const visible = evaluateIsPredicate({
    predicate: 'visible',
    node: baseNode,
    nodes,
    platform: 'ios',
  });
  const hidden = evaluateIsPredicate({
    predicate: 'hidden',
    node: { ...baseNode, rect: { ...baseNode.rect, width: 0 }, hittable: false },
    nodes: [viewportNode, { ...baseNode, rect: { ...baseNode.rect, width: 0 }, hittable: false }],
    platform: 'ios',
  });
  assert.equal(visible.pass, true);
  assert.equal(hidden.pass, true);
});

test('evaluateIsPredicate visible uses ancestor rect for visible list text', () => {
  const listItem = {
    ref: 'e2',
    index: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeCell',
    rect: { x: 0, y: 160, width: 390, height: 44 },
    hittable: false,
  };
  const listText = {
    ref: 'e3',
    index: 2,
    parentIndex: 1,
    type: 'XCUIElementTypeStaticText',
    label: 'Trip ideas',
    hittable: false,
  };
  const visible = evaluateIsPredicate({
    predicate: 'visible',
    node: listText,
    nodes: [viewportNode, listItem, listText],
    platform: 'ios',
  });
  assert.equal(visible.pass, true);
});

test('evaluateIsPredicate visible fails for off-screen nodes', () => {
  const offscreenNode = {
    ...baseNode,
    rect: { x: 20, y: 2600, width: 120, height: 40 },
    hittable: false,
  };
  const visible = evaluateIsPredicate({
    predicate: 'visible',
    node: offscreenNode,
    nodes: [viewportNode, offscreenNode],
    platform: 'ios',
  });
  assert.equal(visible.pass, false);
});

test('evaluateIsPredicate visible fails for zero-size nodes', () => {
  const zeroRectNode = {
    ...baseNode,
    rect: { x: 20, y: 140, width: 0, height: 40 },
    hittable: false,
  };
  const visible = evaluateIsPredicate({
    predicate: 'visible',
    node: zeroRectNode,
    nodes: [viewportNode, zeroRectNode],
    platform: 'ios',
  });
  assert.equal(visible.pass, false);
});

test('evaluateIsPredicate visible does not inherit viewport visibility from generic scroll containers', () => {
  const scrollView = {
    ref: 'e2',
    index: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeScrollView',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: false,
  };
  const wrapper = {
    ref: 'e3',
    index: 2,
    parentIndex: 1,
    type: 'XCUIElementTypeOther',
    hittable: false,
  };
  const listText = {
    ref: 'e4',
    index: 3,
    parentIndex: 2,
    type: 'XCUIElementTypeStaticText',
    label: 'Far item',
    hittable: false,
  };
  const visible = evaluateIsPredicate({
    predicate: 'visible',
    node: listText,
    nodes: [viewportNode, scrollView, wrapper, listText],
    platform: 'ios',
  });
  assert.equal(visible.pass, false);
});

test('evaluateIsPredicate visible resolves parent links by node index instead of array offset', () => {
  const listItem = {
    ref: 'e11',
    index: 11,
    parentIndex: 5,
    type: 'XCUIElementTypeCell',
    rect: { x: 0, y: 160, width: 390, height: 44 },
    hittable: false,
  };
  const listText = {
    ref: 'e12',
    index: 12,
    parentIndex: 11,
    type: 'XCUIElementTypeStaticText',
    label: 'Trip ideas',
    hittable: false,
  };
  const visible = evaluateIsPredicate({
    predicate: 'visible',
    node: listText,
    nodes: [viewportNode, listText, listItem],
    platform: 'ios',
  });
  assert.equal(visible.pass, true);
});

test('evaluateIsPredicate editable and selected', () => {
  const editable = evaluateIsPredicate({
    predicate: 'editable',
    node: baseNode,
    nodes: [viewportNode, baseNode],
    platform: 'ios',
  });
  const selected = evaluateIsPredicate({
    predicate: 'selected',
    node: { ...baseNode, selected: true },
    nodes: [viewportNode, { ...baseNode, selected: true }],
    platform: 'ios',
  });
  assert.equal(editable.pass, true);
  assert.equal(selected.pass, true);
});

test('evaluateIsPredicate text uses equality', () => {
  const match = evaluateIsPredicate({
    predicate: 'text',
    node: baseNode,
    nodes: [viewportNode, baseNode],
    expectedText: 'Email',
    platform: 'ios',
  });
  const mismatch = evaluateIsPredicate({
    predicate: 'text',
    node: baseNode,
    nodes: [viewportNode, baseNode],
    expectedText: 'email',
    platform: 'ios',
  });
  assert.equal(match.pass, true);
  assert.equal(mismatch.pass, false);
});
