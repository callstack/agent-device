import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '@agent-device/capture-kit/snapshot-state-fixtures';
import { iosInteractiveKeyboardCaptureNodes } from '@agent-device/capture-kit/snapshot-chrome-fixtures';
import { selector } from './selector-read-utils.ts';
import { createSettleDevice } from './__tests__/settle-device-fixtures.ts';

// #3469: `--settle` on iOS captured with `interactiveOnly: true`, whose
// projection flattened the keyboard beside app content, so
// `withoutSettleChrome` classified nothing: every key spent a settled-diff
// line. The fixture is the REAL projected `snapshot -i` tree of the Catalog
// search fill (iPhone 17 sim, iOS 27); the pre-fill baseline is its
// app-content prefix (nodes 0-30).

function appOnlyNodes() {
  return iosInteractiveKeyboardCaptureNodes().filter((node) => node.index <= 30);
}

test('the settled diff after a fill shows the keyboard as one line, not one per key', async () => {
  const before = makeSnapshotState(appOnlyNodes(), {
    backend: 'xctest',
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
  const keyboardUp = makeSnapshotState(iosInteractiveKeyboardCaptureNodes(), {
    backend: 'xctest',
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      // Capture 1 = pre-action baseline. Captures 2+ = settle loop sees the keyboard.
      return { snapshot: captures === 1 ? before : keyboardUp };
    },
  });

  const result = await device.interactions.fill(selector('id=catalog-search'), 'kit', {
    session: 'default',
    settle: {},
  });

  const diff = result.settle?.diff;
  assert.ok(diff);
  const texts = diff.lines.map((line) => line.text).join('\n');
  // One line for the keyboard plane; no keys, QuickType candidates, or dock
  // buttons spend budget.
  assert.match(texts, /\[keyboard\]/);
  assert.ok(!diff.lines.some((line) => /\[key\]/.test(line.text)), texts);
  assert.ok(!/Next keyboard|Dictate|Typing Predictions|keep|kind/.test(texts), texts);
  // App content is unchanged; the additions are the keyboard plane line plus
  // two accepted noise residues: the floating toolbar the keyboard-window
  // capture also reports, and the inert QuickType UIScrollView under the
  // assistant markers (no keyboard-owned role of its own; the assistant host
  // is a marker and claims no subtree, so nothing under it is subtree-claimed).
  assert.equal(diff.summary.additions, 3);
  assert.equal(diff.summary.removals, 0);
});
