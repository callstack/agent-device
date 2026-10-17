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

test('the shared vocabulary classifies iOS variant grants on Android trees too', () => {
  // One label vocabulary: the same label states the same role on every tree backend, so
  // `alert accept` can act on the same button on both platforms. Non-button ids keep the
  // classification on the labels rather than the platform id map.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.app.AlertDialog'),
    text(1, 'Location access', 'android:id/alertTitle'),
    button(2, "Don't allow", 'com.example:id/deny', { x: 52, y: 612 }),
    button(3, 'Allow while using the app', 'com.example:id/grant', { x: 210, y: 612 }),
  ]);

  assert.equal(
    chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept')?.label,
    'Allow while using the app',
  );
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss')?.label, "Don't allow");
});

test('the Android 11+ permission sheet resolves its two grants by the preference table', () => {
  // The shipped Android 11+ shape: permission_allow_foreground_only_button and
  // permission_allow_one_time_button both classify accept by id, so the shared ranked choice
  // (not uniqueness) must pick the lasting grant; main pressed it too, so a refusal here
  // regresses a working route.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.google.android.permissioncontroller',
    }),
    text(
      1,
      'Allow Probe to access location in the background?',
      'com.android.permissioncontroller:id/permission_message',
    ),
    button(
      2,
      'While using the app',
      'permission_allow_foreground_only_button',
      { x: 32, y: 1420 },
      true,
    ),
    button(3, 'Only this time', 'permission_allow_one_time_button', { x: 32, y: 1490 }, true),
    button(4, 'Deny', 'permission_deny_button', { x: 32, y: 1560 }, true),
  ]);

  assert.equal(
    chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept')?.label,
    'While using the app',
  );
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss')?.label, 'Deny');
});

test('a localized Android 11+ sheet resolves its grants by the id-derived rank', () => {
  // The maintainer's localized-sheet regression: on a Spanish device neither label is in the
  // English vocabulary, so the label table alone refuses — where main pressed the first
  // permission_allow id. The ids carry the rank: the foreground-only grant outranks the
  // one-time grant whatever the display strings say, and the deny id still answers `dismiss`.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.google.android.permissioncontroller',
    }),
    text(
      1,
      '¿Permitir que Probe acceda a la ubicación?',
      'com.android.permissioncontroller:id/permission_message',
    ),
    button(
      2,
      'Mientras la app está en uso',
      'permission_allow_foreground_only_button',
      { x: 32, y: 1420 },
      true,
    ),
    button(3, 'Solo esta vez', 'permission_allow_one_time_button', { x: 32, y: 1490 }, true),
    button(4, 'No permitir', 'permission_deny_button', { x: 32, y: 1560 }, true),
  ]);

  assert.equal(
    chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept')?.label,
    'Mientras la app está en uso',
  );
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss')?.label, 'No permitir');
});

test('the Android 10 sheet grants foreground-only by its id', () => {
  // Android 10's copy "Allow only while using the app" is outside the vocabulary table; its
  // resource id is the same foreground-only grant id the id-classifier already reads, so the
  // backend rank resolves the pair the labels cannot order.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.android.permissioncontroller',
    }),
    text(
      1,
      'Allow Probe to access this device\u2019s location?',
      'com.android.permissioncontroller:id/permission_message',
    ),
    button(
      2,
      'Allow only while using the app',
      'permission_allow_foreground_only_button',
      { x: 32, y: 1420 },
      true,
    ),
    button(3, 'Allow', 'permission_allow_one_time_button', { x: 32, y: 1490 }, true),
    button(4, "Don't allow", 'permission_deny_button', { x: 32, y: 1560 }, true),
  ]);

  assert.equal(
    chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept')?.label,
    'Allow only while using the app',
  );
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss')?.label, "Don't allow");
});

test('a grant id outside the declared ranks keeps the refusal against a known label', () => {
  // The closest negative to the id-rank positives: a vendor fork's own allow id is a real
  // grant (the id classifier reads `permission_allow*`), yet no declared rank reaches it.
  // Letting the one English label win would press an arbitrary grant of an unordered pair —
  // and the neutral-button fallback must not aim the tap at it either — so both acting
  // choices refuse while the deny id still answers `dismiss`.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.google.android.permissioncontroller',
    }),
    text(
      1,
      'Allow Probe to access contacts?',
      'com.android.permissioncontroller:id/permission_message',
    ),
    button(2, 'Allow', 'permission_allow_button', { x: 32, y: 1420 }, true),
    // A vendor fork's own id, written as the vendor ships it: the fixture does not prefix it
    // with the platform controller's id home (that prefix is what makes a real controller id),
    // and the identifier pattern still reads it as a permission node.
    button(
      3,
      'Always allow and sync',
      'com.vendor.permission:id/permission_allow_always_and_sync_button',
      { x: 32, y: 1490 },
      false,
    ),
    button(4, 'Deny', 'permission_deny_button', { x: 32, y: 1560 }, true),
  ]);

  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept'), null);
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss')?.label, 'Deny');
});

test('two points carrying one grant id refuse instead of resolving by tree order', () => {
  // Same physical rank twice — the id-rank twin of the same-label tie: the capture names the
  // grant at two centers and no single one of them.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.google.android.permissioncontroller',
    }),
    text(
      1,
      'Allow Probe to access contacts?',
      'com.android.permissioncontroller:id/permission_message',
    ),
    button(
      2,
      'While using the app',
      'permission_allow_foreground_only_button',
      { x: 32, y: 1420 },
      true,
    ),
    button(
      3,
      'While using the app',
      'permission_allow_foreground_only_button',
      { x: 32, y: 1640 },
      true,
    ),
    button(4, 'Deny', 'permission_deny_button', { x: 32, y: 1560 }, true),
  ]);

  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept'), null);
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss')?.label, 'Deny');
});

test('nested nodes over one button center deduplicate to one candidate', () => {
  // uiautomator commonly nests the clickable wrapper and the label node at the same center.
  // They are one physical button, and collapsing them must not read as ambiguity.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.app.AlertDialog'),
    text(1, 'Discard draft?', 'android:id/alertTitle'),
    button(2, 'OK', 'android:id/button1', { x: 52, y: 612 }),
    node(3, 'android.widget.TextView', {
      label: 'OK',
      parentIndex: 2,
      rect: { x: 52, y: 612, width: 128, height: 52 },
    }),
  ]);

  assert.deepEqual(candidate?.alert.buttons, ['OK']);
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept')?.label, 'OK');
});

test('the same label at two distinct centers keeps two candidates so the choice refuses', () => {
  // Two spatially distinct OKs are two physical buttons; the capture names no single one, so
  // the shared ranked boundary refuses rather than taking the tree-first candidate.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.app.AlertDialog'),
    text(1, 'Which OK?', 'android:id/alertTitle'),
    button(2, 'OK', 'android:id/button1', { x: 52, y: 612 }),
    button(3, 'OK', 'android:id/button1_copy', { x: 240, y: 612 }),
  ]);

  assert.deepEqual(candidate?.alert.buttons, ['OK', 'OK']);
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept'), null);
});
