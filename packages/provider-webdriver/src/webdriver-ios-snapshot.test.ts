import assert from 'node:assert/strict';
import { test } from 'vitest';
import { acquireWebDriverIosSnapshot } from './webdriver-ios-snapshot.ts';

const SOURCE = `<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Example" label="Example" enabled="true" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeOther name="Content" x="0" y="0" width="390" height="844">
      <XCUIElementTypeButton name="Continue" label="Continue" enabled="true" visible="true" x="24" y="700" width="160" height="48" />
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

test('Appium iOS adapter returns provider facts with explicit unavailable residue', () => {
  const result = acquireWebDriverIosSnapshot(SOURCE, 'cloud-ios-1');

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

test('Appium carries visibility-only and derived keyboard facts before projection', () => {
  assert.deepEqual(acquireWebDriverIosSnapshot(SOURCE, undefined, true).acquisition.keyboard, {
    kind: 'visibility-only',
    visible: true,
  });
  assert.deepEqual(acquireWebDriverIosSnapshot(SOURCE, undefined, false).acquisition.keyboard, {
    kind: 'visibility-only',
    visible: false,
  });
  assert.deepEqual(acquireWebDriverIosSnapshot(SOURCE).acquisition.keyboard, {
    kind: 'unmeasurable',
    reason: 'keyboard-not-observed',
  });
  const withKeyboard = SOURCE.replace(
    '</XCUIElementTypeApplication>',
    '<XCUIElementTypeKeyboard x="0" y="580" width="390" height="264" /></XCUIElementTypeApplication>',
  );
  assert.deepEqual(acquireWebDriverIosSnapshot(withKeyboard).acquisition.keyboard, {
    kind: 'derived',
    derivation: 'docked-tree',
    frame: { x: 0, y: 580, width: 390, height: 264 },
  });
});

test('an offscreen provider keyboard never publishes an empty derived frame', () => {
  const source = SOURCE.replace(
    '</XCUIElementTypeApplication>',
    '<XCUIElementTypeKeyboard x="0" y="844" width="390" height="233" /></XCUIElementTypeApplication>',
  );
  assert.deepEqual(acquireWebDriverIosSnapshot(source).acquisition.keyboard, {
    kind: 'unmeasurable',
    reason: 'keyboard-tree-geometry-unusable',
  });
});
