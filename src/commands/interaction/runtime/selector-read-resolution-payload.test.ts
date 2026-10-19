import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createSelectorDevice } from './__tests__/test-utils/index.ts';
import { ref } from './selector-read-utils.ts';

// ADR 0012 decision 3 / #1349: the resolution payload (`node`, `preActionNodes`) is what the daemon
// computes record-time target-v1 evidence from. Which selector reads carry it is the command
// family's decision: a unique-resolving read does, `is exists` and `is absent` deliberately do not.

const saveSnapshot = () =>
  makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeButton',
      identifier: 'save',
      label: 'Save',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      enabled: true,
      hittable: true,
    },
  ]);

test('runtime get text on a @ref carries the resolved node and the tree it resolved against', async () => {
  const snapshot = saveSnapshot();
  const device = createSelectorDevice(snapshot);

  const result = await device.selectors.get({
    session: 'default',
    property: 'text',
    target: ref('@e1'),
  });

  assert.equal(result.node.identifier, 'save');
  assert.deepEqual(result.preActionNodes, snapshot.nodes);
});

test('runtime is visible carries the resolved node and the tree it resolved against', async () => {
  const snapshot = saveSnapshot();
  const device = createSelectorDevice(snapshot);

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'visible',
    selector: 'label="Save"',
  });

  assert.equal(result.node?.identifier, 'save');
  assert.deepEqual(result.preActionNodes, snapshot.nodes);
});

test('runtime is exists carries no resolution payload', async () => {
  const device = createSelectorDevice(saveSnapshot());

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'exists',
    selector: 'label="Save"',
  });

  assert.equal(result.node, undefined);
  assert.equal(result.preActionNodes, undefined);
});

test('runtime is absent reports only its predicate, selector, and match count', async () => {
  const device = createSelectorDevice(saveSnapshot());

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'absent',
    selector: 'label="Removed row"',
  });

  assert.deepEqual(result, {
    predicate: 'absent',
    pass: true,
    selector: 'label="Removed row"',
    matches: 0,
  });
});
