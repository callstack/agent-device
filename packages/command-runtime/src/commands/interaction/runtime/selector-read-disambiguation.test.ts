import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { selector } from './selector-read-utils.ts';
import { createSelectorDevice } from './__tests__/test-utils/index.ts';

// A label selector that matches several nodes of one row resolves through the captured tree's
// disambiguation, never through a runner query.

test('runtime get text on an iOS label selector disambiguates among same-label nodes in one capture', async () => {
  const snapshot = makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 393, height: 852 },
        enabled: true,
        hittable: true,
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Cell',
        label: 'General',
        rect: { x: 0, y: 100, width: 393, height: 48 },
        enabled: true,
        hittable: true,
      },
      {
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: 'Button',
        label: 'General',
        rect: { x: 0, y: 100, width: 393, height: 48 },
        enabled: true,
        hittable: true,
      },
      {
        index: 3,
        depth: 2,
        parentIndex: 1,
        type: 'StaticText',
        label: 'General',
        rect: { x: 18, y: 112, width: 80, height: 24 },
        enabled: true,
        hittable: false,
      },
    ],
    { backend: 'xctest', producer: 'apple-runner' },
  );
  let captures = 0;
  const device = createSelectorDevice(snapshot, {
    captureSnapshot: () => {
      captures += 1;
      return { snapshot };
    },
  });

  const result = await device.selectors.get({
    session: 'default',
    property: 'text',
    target: selector('label="General"'),
  });

  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'General');
  assert.notEqual(result.node.type, 'Cell');
  assert.deepEqual(result.target, { kind: 'selector', selector: 'label="General"' });
  assert.equal(captures, 1);
});
