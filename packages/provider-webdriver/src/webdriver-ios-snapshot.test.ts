import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  acquireWebDriverIosSnapshot,
  captureWebDriverIosSnapshot,
  publishWebDriverIosSnapshot,
} from './webdriver-ios-snapshot.ts';

const SOURCE = `<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Example" label="Example" enabled="true" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeOther name="Content" x="0" y="0" width="390" height="844">
      <XCUIElementTypeButton name="Continue" label="Continue" enabled="true" visible="true" x="24" y="700" width="160" height="48" />
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

test('Appium iOS snapshots acquire facts and publish regular output through the engine', async () => {
  const source = vi.fn(async () => SOURCE);
  const result = await captureWebDriverIosSnapshot({ source }, undefined, 'cloud-ios-1');

  assert.equal(result.backend, 'xctest');
  assert.equal(result.producer, 'appium-source');
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.nodes?.map((node) => [node.type, node.label, node.parentIndex]),
    [
      ['XCUIElementTypeApplication', 'Example', undefined],
      ['XCUIElementTypeOther', 'Content', 0],
      ['XCUIElementTypeButton', 'Continue', 1],
    ],
  );
  assert.equal(result.nodes?.find((node) => node.label === 'Continue')?.hittable, false);
  assert.equal(source.mock.calls.length, 1);
  assert.ok(result.warnings?.some((warning) => warning.includes('hittability evidence')));
  assert.deepEqual(Object.keys(result).sort(), [
    'backend',
    'nodes',
    'producer',
    'truncated',
    'warnings',
  ]);
  assert.equal(
    result.nodes?.every((node) => !('ref' in node)),
    true,
  );
});

test('Appium iOS options become an engine plan and engine-owned projection', () => {
  const acquired = acquireWebDriverIosSnapshot(SOURCE, {
    raw: true,
    interactiveOnly: true,
    depth: 1,
    scope: 'Continue',
    customActions: true,
  });

  assert.equal(acquired.input.stage, 'acquired');
  assert.deepEqual(acquired.plan.narrowing, {
    depth: null,
    scope: null,
    interactiveOnly: false,
  });
  assert.deepEqual(acquired.input.acquisition.hint, {
    projection: 'raw',
    rawTraversalDepth: null,
    regularPresentedDepth: null,
    interactiveOnly: false,
    customActions: true,
    acquisitionIntent: 'full',
  });
  assert.deepEqual(acquired.input.acquisition.lineage, {});
  assert.deepEqual(acquired.input.acquisition.viewport, {
    kind: 'reported',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  });

  const published = publishWebDriverIosSnapshot(acquired);
  assert.deepEqual(
    published.result.nodes?.map((node) => [node.type, node.label, node.depth, node.parentIndex]),
    [['XCUIElementTypeButton', 'Continue', 0, undefined]],
  );
  assert.deepEqual(published.publication.comparisonIdentity.lineage, {});
});

test('Appium iOS interactive requests stay provider-unpruned and use engine presentation', () => {
  const acquired = acquireWebDriverIosSnapshot(SOURCE, { interactiveOnly: true }, 'ios-1');

  assert.equal(acquired.input.acquisition.hint.interactiveOnly, true);
  assert.equal(acquired.plan.narrowing.interactiveOnly, false);
  const published = publishWebDriverIosSnapshot(acquired);
  assert.equal(
    published.result.nodes?.some((node) => node.label === 'Continue'),
    true,
  );
  assert.equal(published.result.nodes?.find((node) => node.label === 'Continue')?.hittable, false);
});

test('Appium iOS regular presentation fails typed when page source has no viewport', () => {
  const acquired = acquireWebDriverIosSnapshot(
    '<AppiumAUT><XCUIElementTypeOther name="Content"><XCUIElementTypeButton name="Continue" enabled="true" x="0" y="0" width="100" height="40" /></XCUIElementTypeOther></AppiumAUT>',
  );

  assert.deepEqual(acquired.input.acquisition.viewport, {
    kind: 'missing',
    reason: 'not-provided',
  });
  assert.deepEqual(acquired.input.acquisition.residue, [
    { kind: 'unavailable-fact', fact: 'hittability' },
    { kind: 'missing-viewport', reason: 'not-provided' },
  ]);
  assert.throws(
    () => publishWebDriverIosSnapshot(acquired),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.deepEqual(error.details, { reason: 'missing-viewport', field: 'viewport' });
      return true;
    },
  );
});

test('Appium iOS does not promote a non-viewport root rectangle to viewport evidence', () => {
  const acquired = acquireWebDriverIosSnapshot(
    '<AppiumAUT><XCUIElementTypeOther name="Content" x="0" y="0" width="390" height="844"><XCUIElementTypeButton name="Continue" enabled="true" x="0" y="0" width="100" height="40" /></XCUIElementTypeOther></AppiumAUT>',
  );

  assert.deepEqual(acquired.input.acquisition.viewport, {
    kind: 'missing',
    reason: 'not-provided',
  });
});

test('Appium iOS regular presentation fails typed when root geometry is invalid', () => {
  const acquired = acquireWebDriverIosSnapshot(
    '<AppiumAUT><XCUIElementTypeApplication x="0" y="0" width="invalid" height="844"><XCUIElementTypeButton name="Continue" enabled="true" x="0" y="0" width="100" height="40" /></XCUIElementTypeApplication></AppiumAUT>',
  );

  assert.deepEqual(acquired.input.acquisition.viewport, {
    kind: 'missing',
    reason: 'invalid',
  });
  assert.throws(
    () => publishWebDriverIosSnapshot(acquired),
    (error: unknown) => error instanceof AppError && error.details?.reason === 'invalid-viewport',
  );
});

test('Appium iOS truncation is typed and disclosed at response level', async () => {
  const result = await captureWebDriverIosSnapshot(
    { source: async () => SOURCE.replace('<AppiumAUT>', '<AppiumAUT truncated="true">') },
    { raw: true },
  );

  assert.equal(result.truncated, true);
  assert.deepEqual(result.warnings, [
    'Appium page source does not provide hittability evidence; regular snapshot nodes are not actionable.',
    'Appium page source is truncated; the snapshot hierarchy may be incomplete.',
  ]);
});
