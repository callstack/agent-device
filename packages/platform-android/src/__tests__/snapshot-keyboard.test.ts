import assert from 'node:assert/strict';
import { test } from 'vitest';
import { androidSnapshotKeyboardFromTree } from '../snapshot.ts';
import { parseUiHierarchyTree } from '../ui-hierarchy.ts';

const APP_WINDOW =
  '<node window-index="1" window-type="1" window-layer="20" window-active="true" window-focused="true" window-bounds="[0,0][1080,2400]" class="android.widget.FrameLayout" package="com.example" bounds="[0,0][1080,2400]" />';
const GBOARD_WINDOW =
  '<node window-index="0" window-type="2" window-layer="30" window-active="false" window-focused="false" window-bounds="[0,1500][1080,2400]" class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" bounds="[0,1500][1080,2400]" />';

const WINDOW_LIST = { captureMode: 'interactive-windows' } as const;

function tree(...windows: string[]) {
  return parseUiHierarchyTree(`<hierarchy rotation="0">${windows.join('')}</hierarchy>`);
}

test('an input method window on screen is the visible keyboard band', () => {
  assert.deepEqual(androidSnapshotKeyboardFromTree(tree(GBOARD_WINDOW, APP_WINDOW), WINDOW_LIST), {
    kind: 'visible',
    frame: { x: 0, y: 1500, width: 1080, height: 900 },
  });
});

test('separate input method windows publish one band covering all of them', () => {
  const composer =
    '<node window-index="0" window-type="2" window-bounds="[0,1380][1080,1500]" class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" />';
  assert.deepEqual(
    androidSnapshotKeyboardFromTree(tree(composer, GBOARD_WINDOW, APP_WINDOW), WINDOW_LIST),
    { kind: 'visible', frame: { x: 0, y: 1380, width: 1080, height: 1020 } },
  );
});

test('a full window list without an input method window proves the keyboard absent', () => {
  assert.deepEqual(androidSnapshotKeyboardFromTree(tree(APP_WINDOW), WINDOW_LIST), {
    kind: 'absent',
  });
});

test('an input method window with empty bounds draws nothing and reads as absent', () => {
  const empty =
    '<node window-index="0" window-type="2" window-bounds="[0,2400][1080,2400]" class="android.widget.FrameLayout" />';
  assert.deepEqual(androidSnapshotKeyboardFromTree(tree(empty, APP_WINDOW), WINDOW_LIST), {
    kind: 'absent',
  });
});

test('an input method window whose bounds did not measure cannot prove absence', () => {
  const huge = '9'.repeat(400);
  for (const windowBounds of [
    '',
    ' window-bounds="unknown"',
    ` window-bounds="[0,1500][${huge},2400]"`,
  ]) {
    const unmeasured = `<node window-index="0" window-type="2"${windowBounds} class="android.widget.FrameLayout" />`;
    assert.deepEqual(
      androidSnapshotKeyboardFromTree(tree(unmeasured, APP_WINDOW), WINDOW_LIST),
      { kind: 'unmeasurable', reason: 'window-bounds-unavailable' },
      windowBounds,
    );
  }
});

test('a capture that never listed the windows cannot prove absence', () => {
  assert.deepEqual(
    androidSnapshotKeyboardFromTree(tree(APP_WINDOW), { captureMode: 'active-window' }),
    { kind: 'unmeasurable', reason: 'window-list-unavailable' },
  );
  assert.deepEqual(
    androidSnapshotKeyboardFromTree(
      tree('<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" />'),
      WINDOW_LIST,
    ),
    { kind: 'unmeasurable', reason: 'window-list-unavailable' },
  );
});

test('a truncated capture without an input method window cannot prove absence', () => {
  assert.deepEqual(
    androidSnapshotKeyboardFromTree(tree(APP_WINDOW), { ...WINDOW_LIST, helperTruncated: true }),
    { kind: 'unmeasurable', reason: 'capture-truncated' },
  );
  assert.equal(
    androidSnapshotKeyboardFromTree(tree(GBOARD_WINDOW, APP_WINDOW), {
      ...WINDOW_LIST,
      helperTruncated: true,
    }).kind,
    'visible',
    'a window the capture did reach is still measured',
  );
});
