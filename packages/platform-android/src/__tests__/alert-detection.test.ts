import { test } from 'vitest';
import assert from 'node:assert/strict';
import { chooseAndroidAlertButton, findAndroidAlertCandidate } from '../alert-detection.ts';
import { button, node, text } from './alert-fixtures.ts';

test('chooseAndroidAlertButton prefers platform ids over ambiguous labels', () => {
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.app.AlertDialog'),
    node(1, 'android.widget.TextView', {
      label: 'Ambiguous',
      identifier: 'android:id/alertTitle',
    }),
    button(2, 'Not now', 'android:id/button1', { x: 210, y: 612 }),
    button(3, 'Allow', 'android:id/button2', { x: 52, y: 612 }),
    button(4, 'Later', 'android:id/button3', { x: 130, y: 680 }),
  ]);

  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept')?.label, 'Not now');
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss')?.label, 'Allow');
});

test('findAndroidAlertCandidate collects descendants independent of node order', () => {
  const candidate = findAndroidAlertCandidate([
    text(3, 'Leave without saving?', 'android:id/message', 2),
    button(4, 'Discard', 'android:id/button1', { x: 210, y: 612 }, false, 2),
    node(1, 'android.app.AlertDialog'),
    text(2, 'Unsaved changes', 'android:id/alertTitle', 1),
    node(0, 'android.widget.FrameLayout'),
  ]);

  assert.deepEqual(candidate?.alert, {
    title: 'Unsaved changes',
    message: 'Leave without saving?',
    buttons: ['Discard'],
    platform: 'android',
    source: 'native-dialog',
    packageName: 'com.example.app',
  });
});

test('findAndroidAlertCandidate ignores normal app message ids', () => {
  const candidate = findAndroidAlertCandidate([
    text(1, 'Latest chat message', 'com.example:id/message'),
    button(2, 'Reply', 'com.example:id/reply', { x: 210, y: 612 }),
    button(3, 'Archive', 'com.example:id/archive', { x: 52, y: 612 }),
    node(0, 'android.widget.FrameLayout'),
  ]);

  assert.equal(candidate, null);
});

test('chooseAndroidAlertButton accepts a single neutral button', () => {
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.app.AlertDialog'),
    text(1, 'Storage full', 'android:id/alertTitle'),
    button(2, 'Later', 'android:id/button3', { x: 130, y: 680 }),
  ]);

  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept')?.label, 'Later');
});
