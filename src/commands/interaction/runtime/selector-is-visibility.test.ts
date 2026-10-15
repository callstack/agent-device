import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { selector } from './selector-read-utils.ts';
import { createSelectorDevice } from './__tests__/test-utils/index.ts';

// What `is visible` decides about a matched node: it inherits the viewport visibility of an
// ancestor that has a rect, and a node outside the viewport fails the assertion.

test('runtime is visible passes for list text that inherits viewport visibility from an ancestor', async () => {
  const snapshot = makeSnapshotState(
    [
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeCell',
        rect: { x: 0, y: 160, width: 390, height: 44 },
        hittable: false,
      },
      {
        index: 2,
        parentIndex: 1,
        type: 'XCUIElementTypeStaticText',
        label: 'Trip ideas',
        hittable: false,
      },
    ],
    { backend: 'xctest', producer: 'apple-runner' },
  );
  const device = createSelectorDevice(snapshot);

  const result = await device.selectors.isVisible(selector('label="Trip ideas"'), {
    session: 'default',
  });

  assert.equal(result.predicate, 'visible');
  assert.equal(result.pass, true);
  assert.equal(result.selector, 'label="Trip ideas"');
});

test('runtime is visible fails for nodes outside the current viewport', async () => {
  const snapshot = makeSnapshotState(
    [
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeStaticText',
        label: 'Far item',
        rect: { x: 20, y: 2600, width: 120, height: 40 },
        hittable: false,
      },
    ],
    { backend: 'xctest', producer: 'apple-runner' },
  );
  const device = createSelectorDevice(snapshot);

  await assert.rejects(
    () => device.selectors.isVisible(selector('label="Far item"'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, /actual=\{"visible":false/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'predicate_failed');
      assert.equal(details?.predicate, 'visible');
      return true;
    },
  );
});
