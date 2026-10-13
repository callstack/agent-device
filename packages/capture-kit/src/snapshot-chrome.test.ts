import { test } from 'vitest';
import assert from 'node:assert/strict';
import { attachRefs, type RawSnapshotNode, type SnapshotNode } from '@agent-device/kernel/snapshot';
import { collectSettleChromeRefs, withoutSettleChrome } from './snapshot-chrome.ts';
import { iosInteractiveKeyboardCaptureNodes } from './snapshot-chrome.fixtures.ts';

function refFor(nodes: SnapshotNode[], label: string): string {
  const node = nodes.find((candidate) => candidate.label === label);
  assert.ok(node?.ref, `expected a node labelled "${label}" with a ref`);
  return node.ref;
}

function refForIdentifier(nodes: SnapshotNode[], identifier: string): string {
  const node = nodes.find((candidate) => candidate.identifier === identifier);
  assert.ok(node?.ref, `expected a node identified "${identifier}" with a ref`);
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

// #3469: the interactive projection flattens the keyboard's assistant bar and
// dock buttons beside app content and keeps the [Keyboard] plane as a bare
// top-level line, so the window walk cannot reach them. The keyboard-owned
// UIKit classes in `role` carry the classification through the flattening.
test('the real interactive keyboard capture collapses to one [Keyboard] diff line', () => {
  const nodes = attachRefs(iosInteractiveKeyboardCaptureNodes());
  const survivors = withoutSettleChrome(nodes, undefined);
  const chromeRefs = collectSettleChromeRefs(nodes, undefined);

  // Every key, the QuickType bar (host, page, predictions), and the dock
  // buttons are chrome; the keyboard plane itself stays visible as the
  // "keyboard appeared" signal.
  const keyboard = nodes.find((node) => node.type === 'Keyboard');
  assert.ok(keyboard?.ref);
  assert.equal(chromeRefs.has(keyboard.ref), true);
  for (const node of nodes) {
    const isKeyboardSurface =
      node.type === 'Key' ||
      node.role === 'UIKeyboardLayoutStar' ||
      node.role === 'TUISystemInputAssistantView' ||
      node.role === 'TUIPredictionViewCell' ||
      node.role === 'UIKeyboardDockItemButton';
    if (isKeyboardSurface) {
      // An iOS capture mints refs densely, so a keyboard surface always has one to be chrome under.
      assert.ok(node.ref, `keyboard surface ${node.index} carries no ref`);
      assert.equal(chromeRefs.has(node.ref), true, `node ${node.index}`);
    }
  }

  // The stripped set collapses the ~50 keyboard-surface nodes; what survives is
  // app content plus the keyboard plane line and two accepted residues: the
  // floating home-indicator Toolbar (31) and the inert QuickType UIScrollView
  // (35) under the assistant markers, which declare no keyboard-owned role and
  // are not under a system-only subtree host. Noise lines fail loudly; a
  // subtree claim through the assistant host could swallow app controls.
  assert.equal(survivors.filter((node) => node.type === 'Key').length, 0);
  assert.deepEqual(
    survivors.filter((node) => node.index >= 31).map((node) => node.type),
    ['Toolbar', 'ScrollView', 'Keyboard'],
  );
  // App content never rides along: the search field the fill targeted survives.
  assert.equal(chromeRefs.has(refFor(nodes, 'Search products')), false);
});

// The system inputView host frame is chrome itself, but an app's custom
// UITextField.inputView content renders under it and must survive.
test('the inputView host frame is stripped without swallowing app input-view content', () => {
  const nodes = attachRefs([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      identifier: 'inputView',
      role: '_UIRemoteKeyboardPlaceholderView',
      rect: { x: 0, y: 590, width: 402, height: 284 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Custom keypad key',
      identifier: 'app-keypad-7',
      rect: { x: 10, y: 600, width: 80, height: 80 },
      hittable: true,
    },
  ]);
  const survivors = withoutSettleChrome(nodes, undefined);

  assert.equal(
    survivors.some((node) => node.index === 1),
    false,
    'the placeholder host frame itself is chrome',
  );
  assert.equal(
    collectSettleChromeRefs(nodes, undefined).has(refFor(nodes, 'Custom keypad key')),
    false,
    'content the app hosts inside its own inputView is not keyboard chrome',
  );
});

// An app that hosts editable text under a keyboard MARKER host (its own composer
// riding the input-assistant host) keeps the field it is typing into: the marker
// is chrome itself and owns no subtree.
test('editable text hosted under a keyboard marker host survives classification', () => {
  const nodes = attachRefs([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      role: 'TUISystemInputAssistantView',
      identifier: 'SystemInputAssistantView',
      rect: { x: 0, y: 546, width: 402, height: 44 },
      hittable: true,
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'TextField',
      label: 'Compose',
      rect: { x: 8, y: 550, width: 300, height: 36 },
      hittable: true,
    },
  ]);
  const chromeRefs = collectSettleChromeRefs(nodes, undefined);

  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'SystemInputAssistantView')), true);
  assert.equal(chromeRefs.has(refFor(nodes, 'Compose')), false);
});

// The window pass exempts app content above the keys, and the keyboard-owned subtree walk must
// not outrank that exemption: an app's UITextField.inputAssistantItem bar button renders UNDER
// the system assistant view and declares no keyboard-owned role, so it stays an app control —
// while a system prediction cell beside it, which owns its chrome by role wherever it sits,
// still collapses.
test('app inputAssistantItem buttons under the assistant view keep the accessory exemption', () => {
  const nodes = attachRefs([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      label: 'Keyboard Window',
      rect: { x: 0, y: 300, width: 402, height: 574 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      role: 'TUISystemInputAssistantView',
      label: 'Assistant Bar',
      rect: { x: 0, y: 300, width: 402, height: 44 },
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'Paste',
      rect: { x: 8, y: 306, width: 60, height: 32 },
      hittable: true,
    },
    {
      index: 4,
      depth: 3,
      parentIndex: 2,
      type: 'Button',
      role: 'TUIPredictionViewCell',
      label: 'keep',
      rect: { x: 200, y: 306, width: 60, height: 32 },
      hittable: true,
    },
    {
      index: 5,
      depth: 2,
      parentIndex: 1,
      type: 'Keyboard',
      label: 'Keyboard',
      rect: { x: 0, y: 360, width: 402, height: 514 },
    },
    {
      index: 6,
      depth: 3,
      parentIndex: 5,
      type: 'Key',
      label: 'q',
      rect: { x: 0, y: 380, width: 39, height: 54 },
    },
  ]);
  const chromeRefs = collectSettleChromeRefs(nodes, undefined);

  assert.equal(
    chromeRefs.has(refFor(nodes, 'Paste')),
    false,
    'the app-provided assistant-item button is exempt, not re-claimed through the assistant subtree',
  );
  assert.equal(chromeRefs.has(refFor(nodes, 'keep')), true);
  assert.equal(chromeRefs.has(refFor(nodes, 'Assistant Bar')), true);
  assert.equal(chromeRefs.has(refFor(nodes, 'q')), true);
});

// The route #3469 targets: the interactive projection has NO Window anchor, so the
// app-accessory exemption is empty and only the marker rule protects app content. An
// app Button under the assistant view survives on its own; a prediction cell beside
// it, chrome by its own declared role, still collapses.
test('an app control under the assistant host survives on the Window-less interactive shape', () => {
  const nodes = attachRefs([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'TextField',
      label: 'Search',
      rect: { x: 18, y: 100, width: 366, height: 44 },
      hittable: true,
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      role: 'TUISystemInputAssistantView',
      rect: { x: 0, y: 546, width: 402, height: 44 },
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 2,
      type: 'Button',
      label: 'Paste',
      rect: { x: 8, y: 550, width: 60, height: 36 },
      hittable: true,
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 2,
      type: 'Button',
      role: 'TUIPredictionViewCell',
      label: 'keep',
      rect: { x: 200, y: 550, width: 60, height: 36 },
      hittable: true,
    },
    {
      index: 5,
      depth: 1,
      parentIndex: 0,
      type: 'Keyboard',
      role: 'UIKeyboardAutomatic',
      rect: { x: 0, y: 606, width: 402, height: 268 },
    },
    {
      index: 6,
      depth: 2,
      parentIndex: 5,
      type: 'Key',
      role: 'UIAccessibilityElementKBKey',
      label: 'q',
      rect: { x: 0, y: 620, width: 39, height: 54 },
    },
  ]);
  const chromeRefs = collectSettleChromeRefs(nodes, undefined);

  assert.equal(
    chromeRefs.has(refFor(nodes, 'Paste')),
    false,
    'the assistant host is a marker: it claims no subtree, so an app control under it survives',
  );
  assert.equal(chromeRefs.has(refFor(nodes, 'keep')), true);
  assert.equal(chromeRefs.has(refFor(nodes, 'Search')), false);
});

// A capture that reports the key plane or the prediction bar WITHOUT any key/cell/marker
// sibling: the subtree-role hosts alone must still strip their subtrees, or the empty-set
// early return re-leaks the plane's inert children into the settle diff and tail budget.
test('a subtree-role host with no surface or marker sibling still strips its subtree', () => {
  const nodes = attachRefs([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      role: 'UIKeyboardLayoutStar',
      rect: { x: 0, y: 606, width: 402, height: 268 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'autoguess candidate row',
      rect: { x: 0, y: 606, width: 402, height: 44 },
    },
    {
      index: 3,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      role: 'TUIPredictionView',
      label: 'Typing Predictions',
      rect: { x: 0, y: 546, width: 402, height: 44 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 3,
      type: 'Other',
      rect: { x: 0, y: 546, width: 402, height: 44 },
    },
  ]);
  const survivors = withoutSettleChrome(nodes, undefined);
  const chromeRefs = collectSettleChromeRefs(nodes, undefined);

  assert.deepEqual(
    survivors.map((node) => node.index),
    [0],
  );
  assert.equal(chromeRefs.size, 4);
});

test('public bar membership classifies an ancestor-free leaf without hiding an actionable SystemUI overlay', () => {
  const nodes = attachRefs([
    { index: 0, bundleId: 'com.android.systemui', label: 'Back', systemBar: 'navigation' },
    {
      index: 1,
      bundleId: 'com.android.systemui',
      label: 'Volume',
      identifier: 'com.android.systemui:id/volume_dialog',
    },
  ]);
  assert.deepEqual([...collectSettleChromeRefs(nodes, 'com.example')], [nodes[0]!.ref]);
  assert.deepEqual(
    withoutSettleChrome(nodes, 'com.example').map((node) => node.label),
    ['Volume'],
  );
});
