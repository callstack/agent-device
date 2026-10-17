import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createSelectorDevice } from './__tests__/test-utils/index.ts';

const APPLICATION = {
  index: 0,
  type: 'Application',
  rect: { x: 0, y: 0, width: 800, height: 1200 },
};

const followButton = (index: number, x: number) => ({
  index,
  parentIndex: 0,
  type: 'Button',
  label: 'Follow',
  hittable: true,
  rect: { x, y: 100, width: 80, height: 40 },
});

// #1625 decision 1: `find <q> list` is the read-only inspection surface the ambiguity recovery
// hint points at. The test device's backend has no touch member, so a list that acted would throw.
test('runtime find list returns every matching node with its ref', async () => {
  const device = createSelectorDevice(
    makeSnapshotState([APPLICATION, followButton(1, 0), followButton(2, 90), followButton(3, 180)]),
  );

  const listed = await device.selectors.find({
    session: 'default',
    locator: 'text',
    query: 'Follow',
    action: 'list',
  });

  assert.equal(listed.kind, 'list');
  assert.deepEqual(
    listed.matches.map((entry) => entry.ref),
    ['@e2', '@e3', '@e4'],
  );
});

test('runtime find list on a unique match still lists instead of acting', async () => {
  const device = createSelectorDevice(
    makeSnapshotState([
      APPLICATION,
      {
        index: 1,
        parentIndex: 0,
        type: 'Cell',
        label: 'Dictionary',
        hittable: true,
        rect: { x: 0, y: 100, width: 800, height: 44 },
      },
    ]),
  );

  const listed = await device.selectors.find({
    session: 'default',
    query: 'Dictionary',
    action: 'list',
  });

  assert.equal(listed.kind, 'list');
  assert.deepEqual(
    listed.matches.map((entry) => entry.ref),
    ['@e2'],
  );
});
