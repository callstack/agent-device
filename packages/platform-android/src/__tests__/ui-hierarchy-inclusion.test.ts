import { expect, test } from 'vitest';
import { shouldIncludeAndroidNode } from '../ui-hierarchy-inclusion.ts';
import type { AndroidNode } from '../ui-hierarchy-node.ts';
import {
  ANDROID_DEVICE_NAME_DIALOG_RAW_NODES,
  walkInteractiveOnlyAndroidFixture,
} from '../ui-hierarchy.fixtures.ts';

test('interactive inclusion keeps positive agent targets and rejects degenerate geometry', () => {
  expect(
    shouldIncludeAndroidNode(
      node({ clickable: true }),
      { interactiveOnly: true },
      false,
      false,
      false,
      false,
    ),
  ).toBe(true);
  expect(
    shouldIncludeAndroidNode(
      node({ clickable: true, rect: { x: 10, y: 10, width: 0, height: 20 } }),
      { interactiveOnly: true },
      false,
      false,
      false,
      false,
    ),
  ).toBe(false);
});

test('interactive inclusion keeps a semantic Compose proxy only in actionable context', () => {
  const semanticView = node({ type: 'android.view.View', label: 'Start a call' });
  expect(
    shouldIncludeAndroidNode(semanticView, { interactiveOnly: true }, true, false, false, false),
  ).toBe(true);
  expect(
    shouldIncludeAndroidNode(semanticView, { interactiveOnly: true }, false, false, false, false),
  ).toBe(false);
});

test('interactive inclusion keeps an AlertDialog title and drops screen text outside the dialog', () => {
  const labels = walkInteractiveOnlyAndroidFixture(ANDROID_DEVICE_NAME_DIALOG_RAW_NODES).map(
    (presented) => presented.label,
  );
  expect(labels).toContain('Device name');
  expect(labels).toEqual(expect.arrayContaining(['sdk_gphone64_arm64', 'Cancel', 'OK']));
  expect(labels).not.toContain('4:37');
});

test('interactive inclusion keeps passive text only inside an alert panel', () => {
  const title = node({ type: 'android.widget.TextView', label: 'Device name' });
  expect(
    shouldIncludeAndroidNode(title, { interactiveOnly: true }, false, false, false, true),
  ).toBe(true);
  expect(
    shouldIncludeAndroidNode(title, { interactiveOnly: true }, false, false, false, false),
  ).toBe(false);
  const panelLayout = node({ type: 'android.widget.LinearLayout', label: 'Panel' });
  expect(
    shouldIncludeAndroidNode(panelLayout, { interactiveOnly: true }, false, false, false, true),
  ).toBe(false);
});

test('regular inclusion preserves meaningful structural nodes and actionable descendants', () => {
  expect(
    shouldIncludeAndroidNode(
      node({ type: 'android.view.View', label: 'Panel' }),
      {},
      false,
      false,
      false,
      false,
    ),
  ).toBe(true);
  expect(
    shouldIncludeAndroidNode(node({ type: 'android.view.View' }), {}, false, true, false, false),
  ).toBe(true);
  expect(
    shouldIncludeAndroidNode(node({ type: 'android.view.View' }), {}, false, false, false, false),
  ).toBe(false);
});

function node(overrides: Partial<AndroidNode>): AndroidNode {
  return {
    type: 'android.widget.Button',
    label: null,
    value: null,
    passiveFacts: {},
    identifier: null,
    packageName: null,
    rect: { x: 0, y: 0, width: 20, height: 20 },
    clickable: false,
    focusable: false,
    depth: 0,
    children: [],
    ...overrides,
  };
}
