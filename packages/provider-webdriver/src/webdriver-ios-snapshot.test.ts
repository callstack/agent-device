import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveKeyboardTapOcclusion } from '@agent-device/contracts/tap-keyboard-occlusion';
import { presentIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-runtime';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
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
    '<XCUIElementTypeKeyboard x="0" y="580" width="390" height="264"><XCUIElementTypeButton name="Done" x="200" y="600" width="100" height="40" /></XCUIElementTypeKeyboard></XCUIElementTypeApplication>',
  );
  const acquired = acquireWebDriverIosSnapshot(withKeyboard).acquisition;
  assert.equal(acquired.nodes.find((node) => node.label === 'Done')?.keyboardOwned, true);
  assert.deepEqual(acquired.keyboard, {
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
    kind: 'tree-rejected',
    derivation: 'docked-tree',
  });
});

test.each([
  '_UIRemoteKeyboardPlaceholderView',
  'TUISystemInputAssistantView',
  'TUISystemInputAssistantPageView',
])('app controls under %s remain unowned through projection and state assembly', (role) => {
  const source = SOURCE.replace(
    '</XCUIElementTypeApplication>',
    `<XCUIElementTypeKeyboard x="0" y="580" width="390" height="264"><XCUIElementTypeOther class="${role}"><XCUIElementTypeButton name="Save draft" x="200" y="600" width="100" height="40" /></XCUIElementTypeOther><XCUIElementTypeOther class="UIKeyboardLayoutStar"><XCUIElementTypeButton name="Done" x="0" y="600" width="100" height="40" /></XCUIElementTypeOther></XCUIElementTypeKeyboard></XCUIElementTypeApplication>`,
  );
  const result = acquireWebDriverIosSnapshot(source);
  const acquired = result.acquisition;
  const appControl = acquired.nodes.find((node) => node.label === 'Save draft')!;
  const projected = [{}, { interactiveOnly: true }, { raw: true }, { scope: 'Save draft' }].map(
    (options) =>
      buildSnapshotState(presentIosSnapshotAcquisition(result, options), {
        snapshotRaw: options.raw,
        snapshotInteractiveOnly: options.interactiveOnly,
      }).nodes,
  );
  for (const nodes of [acquired.nodes, [appControl], ...projected]) {
    const node = nodes.find((candidate) => candidate.label === 'Save draft')!;
    assert.equal(
      resolveKeyboardTapOcclusion({
        nodes,
        node,
        viewport: null,
        point: { x: 250, y: 620 },
        keyboard: acquired.keyboard,
      }).kind,
      'occluded',
    );
  }
  assert.equal(appControl.keyboardOwned, false);
  assert.equal(acquired.nodes.find((node) => node.role === role)?.keyboardOwned, true);
  assert.equal(acquired.nodes.find((node) => node.label === 'Done')?.keyboardOwned, true);
});

test.each([true, false, 'failed'] as const)(
  'Appium iOS probe %s without a viewport preserves later tree derivation',
  (visibility) => {
    const source =
      '<AppiumAUT><XCUIElementTypeOther><XCUIElementTypeOther x="0" y="0" width="390" height="844"><XCUIElementTypeButton name="Continue" x="20" y="700" width="100" height="40" /></XCUIElementTypeOther><XCUIElementTypeKeyboard x="0" y="580" width="390" height="264" /></XCUIElementTypeOther></AppiumAUT>';
    const acquired = acquireWebDriverIosSnapshot(source, undefined, visibility).acquisition;
    assert.equal(acquired.viewport.kind, 'missing');
    const node = acquired.nodes.find((node) => node.label === 'Continue')!;
    assert.equal(
      resolveKeyboardTapOcclusion({
        nodes: acquired.nodes,
        node,
        viewport: { x: 0, y: 0, width: 390, height: 844 },
        point: { x: 70, y: 720 },
        keyboard: acquired.keyboard,
      }).kind,
      'occluded',
    );
  },
);

test('Appium acquisition interprets an RN tuple but keeps native-control and bare-state values', () => {
  const result = acquireWebDriverIosSnapshot(`<AppiumAUT>
    <XCUIElementTypeOther value="radio button, checked" />
    <XCUIElementTypeTextField value="checkbox, checked" />
    <XCUIElementTypeOther value="unchecked" />
  </AppiumAUT>`);
  const [radio, field, literal] = result.acquisition.nodes;
  assert.equal(radio?.checked, true);
  assert.equal(radio?.value, 'radio button, checked');
  assert.equal(radio?.iosValueSemantics?.role, 'radio');
  assert.equal(field?.iosValueSemantics, undefined);
  assert.equal(literal?.iosValueSemantics, undefined);
});
