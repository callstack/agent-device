import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  captureWebDriverIosSnapshot,
  acquireWebDriverIosSnapshot,
} from './webdriver-ios-snapshot.ts';

const SOURCE = `<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Example" label="Example" enabled="true" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeOther name="Content" x="0" y="0" width="390" height="844">
      <XCUIElementTypeButton name="Continue" label="Continue" enabled="true" visible="true" x="24" y="700" width="160" height="48" />
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

test('Appium iOS adapter returns provider facts with explicit unavailable residue', async () => {
  const source = vi.fn(async () => SOURCE);
  const result = await captureWebDriverIosSnapshot({ source }, 'cloud-ios-1');

  assert.equal(result.stage, 'acquired');
  assert.equal(result.acquisition.producer, 'appium-source');
  assert.deepEqual(result.acquisition.lineage, { targetId: 'cloud-ios-1' });
  assert.deepEqual(
    result.acquisition.nodes.map((node) => [node.type, node.label, node.parentIndex]),
    [
      ['XCUIElementTypeApplication', 'Example', undefined],
      ['XCUIElementTypeOther', 'Content', 0],
      ['XCUIElementTypeButton', 'Continue', 1],
    ],
  );
  assert.equal(result.acquisition.truncated, undefined);
  assert.deepEqual(result.acquisition.residue, [
    { kind: 'unavailable-fact', fact: 'hittability' },
    { kind: 'unavailable-fact', fact: 'acquisition-depth' },
    { kind: 'unavailable-fact', fact: 'truncation' },
  ]);
  assert.equal(source.mock.calls.length, 1);
});

test('Appium iOS adapter preserves provider-reported node facts for the host presenter', () => {
  const result = acquireWebDriverIosSnapshot(
    '<AppiumAUT><XCUIElementTypeApplication x="0" y="0" width="390" height="844"><XCUIElementTypeButton name="Continue" hittable="true" /></XCUIElementTypeApplication></AppiumAUT>',
    'ios-2',
  );

  assert.equal(result.acquisition.nodes[1]?.hittable, true);
  assert.deepEqual(result.acquisition.viewport, {
    kind: 'reported',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  });
});

test('Appium iOS adapter carries missing viewport evidence without presenting or inferring it', () => {
  const result = acquireWebDriverIosSnapshot(
    '<AppiumAUT><XCUIElementTypeOther name="Content"><XCUIElementTypeButton name="Continue" /></XCUIElementTypeOther></AppiumAUT>',
  );

  assert.deepEqual(result.acquisition.viewport, {
    kind: 'missing',
    reason: 'not-provided',
  });
  assert.deepEqual(result.acquisition.residue, [
    { kind: 'unavailable-fact', fact: 'hittability' },
    { kind: 'unavailable-fact', fact: 'acquisition-depth' },
    { kind: 'unavailable-fact', fact: 'truncation' },
    { kind: 'missing-viewport', reason: 'not-provided' },
  ]);
});
