import { test } from 'vitest';
import assert from 'node:assert/strict';
import { attachRefs, type RawSnapshotNode, type SnapshotNode } from '../../kernel/snapshot.ts';
import { collectSettleChromeRefs } from '../snapshot-chrome.ts';

function refFor(nodes: SnapshotNode[], label: string): string {
  const node = nodes.find((candidate) => candidate.label === label);
  assert.ok(node?.ref, `expected a node labelled "${label}" with a ref`);
  return node.ref;
}

// iOS keyboard window (iPhone 17 Pro shape): the [Keyboard] container holds the
// keys, and the "Next keyboard"/"Dictate" assistant buttons render inside the
// keyboard's own frame at the bottom of the screen. An inputAccessoryView
// toolbar the app hosts in the same window renders as a bar ABOVE the keys.
function iosKeyboardWindowNodes(options: { withAccessory: boolean }): RawSnapshotNode[] {
  const keyboardTop = 360;
  const keys = Array.from({ length: 26 }, (_, key) => ({
    index: 100 + key,
    depth: 4,
    parentIndex: 5,
    type: 'Key',
    label: String.fromCharCode(97 + key),
    rect: {
      x: (key % 10) * 40,
      y: keyboardTop + 20 + Math.floor(key / 10) * 54,
      width: 39,
      height: 54,
    },
  }));
  return [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      label: 'Keyboard Window',
      rect: { x: 0, y: 300, width: 402, height: 574 },
    },
    ...(options.withAccessory
      ? [
          {
            index: 2,
            depth: 2,
            parentIndex: 1,
            type: 'Other',
            label: 'Accessory Bar',
            rect: { x: 0, y: 300, width: 402, height: 44 },
          },
          {
            index: 3,
            depth: 3,
            parentIndex: 2,
            type: 'Button',
            label: 'Send',
            identifier: 'composer-send',
            rect: { x: 300, y: 306, width: 90, height: 36 },
            hittable: true,
          },
        ]
      : []),
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Keyboard Host',
      rect: { x: 0, y: keyboardTop, width: 402, height: 514 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 4,
      type: 'Keyboard',
      label: 'Padding-Left',
      rect: { x: 0, y: keyboardTop, width: 402, height: 514 },
    },
    ...keys,
    {
      index: 200,
      depth: 3,
      parentIndex: 4,
      type: 'Button',
      label: 'Next keyboard',
      rect: { x: 8, y: 806, width: 68, height: 44 },
      hittable: true,
    },
    {
      index: 201,
      depth: 3,
      parentIndex: 4,
      type: 'Button',
      label: 'Dictate',
      rect: { x: 325, y: 805, width: 68, height: 44 },
    },
  ];
}

test('iOS app-owned inputAccessoryView controls above the keyboard survive chrome classification', () => {
  const nodes = attachRefs(iosKeyboardWindowNodes({ withAccessory: true }));
  const chromeRefs = collectSettleChromeRefs(nodes, undefined);

  // Keyboard keys and the system assistant buttons ARE chrome.
  assert.equal(chromeRefs.has(refFor(nodes, 'q')), true);
  assert.equal(chromeRefs.has(refFor(nodes, 'Next keyboard')), true);
  assert.equal(chromeRefs.has(refFor(nodes, 'Dictate')), true);
  // The app's accessory "Send" button (rendered above the keys) is NOT chrome.
  assert.equal(chromeRefs.has(refFor(nodes, 'Send')), false);
});

test('iOS genuine key-only keyboard window still classifies every keyboard control as chrome', () => {
  const nodes = attachRefs(iosKeyboardWindowNodes({ withAccessory: false }));
  const chromeRefs = collectSettleChromeRefs(nodes, undefined);

  assert.equal(chromeRefs.has(refFor(nodes, 'q')), true);
  assert.equal(chromeRefs.has(refFor(nodes, 'Next keyboard')), true);
  assert.equal(chromeRefs.has(refFor(nodes, 'Dictate')), true);
  // The keyboard window node itself is chrome (structural spine, never an app target).
  assert.equal(chromeRefs.has(refFor(nodes, 'Keyboard Window')), true);
});

const LATIN_IME = 'com.google.android.inputmethod.latin';

test('Android classifier filters IME keys but keeps app dialog and unmarked SystemUI controls', () => {
  const nodes = attachRefs([
    {
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      bundleId: 'com.example.app',
      rect: { x: 0, y: 0, width: 1080, height: 2400 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Submit',
      bundleId: 'com.example.app',
      rect: { x: 40, y: 200, width: 1000, height: 140 },
      hittable: true,
    },
    // System dialog button (package `android`) — a legitimate actionable control.
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Allow',
      bundleId: 'android',
      identifier: 'android:id/button1',
      rect: { x: 600, y: 1200, width: 400, height: 140 },
      hittable: true,
    },
    // Unmarked SystemUI overlay control (volume panel), NOT status/nav-bar chrome.
    {
      index: 3,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.ImageButton',
      label: 'Volume',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/volume_dialog_button',
      rect: { x: 980, y: 900, width: 80, height: 80 },
      hittable: true,
    },
    // IME container + a key: both IME-owned, both chrome.
    {
      index: 4,
      depth: 1,
      parentIndex: 0,
      type: 'android.inputmethodservice.SoftInputWindow',
      bundleId: LATIN_IME,
      rect: { x: 0, y: 1600, width: 1080, height: 800 },
    },
    {
      index: 5,
      depth: 2,
      parentIndex: 4,
      type: 'android.inputmethodservice.Keyboard$Key',
      label: 'q',
      bundleId: LATIN_IME,
      rect: { x: 0, y: 1700, width: 108, height: 160 },
    },
  ]);
  const chromeRefs = collectSettleChromeRefs(nodes, 'com.example.app');

  // IME key IS filtered.
  assert.equal(chromeRefs.has(refFor(nodes, 'q')), true);
  // Legitimate app / system-dialog / unmarked-SystemUI controls are NOT filtered.
  assert.equal(chromeRefs.has(refFor(nodes, 'Submit')), false);
  assert.equal(chromeRefs.has(refFor(nodes, 'Allow')), false);
  assert.equal(chromeRefs.has(refFor(nodes, 'Volume')), false);
});
