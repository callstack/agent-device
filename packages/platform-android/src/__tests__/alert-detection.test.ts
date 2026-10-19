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

test('the Android 14+ partial-media sheet resolves "Allow all" by the id-derived rank', () => {
  // The AOSP READ_MEDIA_IMAGES/VIDEO partial sheet: permission_allow_all_button ("Allow all")
  // and permission_allow_selected_button ("Select photos and videos") both classify accept by
  // id. On the English sheet the label table ranks "Allow all" but no label reaches the other,
  // so a mixed-source pair would refuse where main pressed the lasting grant. The ids carry the
  // rank: the full grant outranks the picker-limited grant.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.google.android.permissioncontroller',
    }),
    text(
      1,
      'Allow Probe to access photos and videos on your device?',
      'com.android.permissioncontroller:id/permission_message',
    ),
    button(2, 'Allow all', 'permission_allow_all_button', { x: 32, y: 1420 }, true),
    button(
      3,
      'Select photos and videos',
      'permission_allow_selected_button',
      {
        x: 32,
        y: 1490,
      },
      true,
    ),
    button(4, "Don't allow", 'permission_deny_button', { x: 32, y: 1560 }, true),
  ]);

  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept')?.label, 'Allow all');
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss')?.label, "Don't allow");
});

test('a localized Android 14+ partial-media sheet resolves "Allow all" by the id alone', () => {
  // The pure id-driven twin: with both media labels outside the English vocabulary, only the
  // declared ids order the pair.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.google.android.permissioncontroller',
    }),
    text(
      1,
      '¿Permitir que Probe acceda a tus fotos y vídeos?',
      'com.android.permissioncontroller:id/permission_message',
    ),
    button(2, 'Permitir todo', 'permission_allow_all_button', { x: 32, y: 1420 }, true),
    button(
      3,
      'Seleccionar fotos y vídeos',
      'permission_allow_selected_button',
      {
        x: 32,
        y: 1490,
      },
      true,
    ),
    button(4, 'No permitir', 'permission_deny_button', { x: 32, y: 1560 }, true),
  ]);

  assert.equal(
    chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept')?.label,
    'Permitir todo',
  );
});

test('every declared permissioncontroller grant id carries a rank beside its role', () => {
  // The maintainer's cohesion rule: no accepted permissioncontroller id may state a role from an
  // id while no rank reaches it. Pair each known grant id with another known grant id: the two
  // accept candidates come from one source, so a missing rank shows up as a refusal.
  const knownGrantIds = [
    'permission_allow_all_button',
    'permission_allow_foreground_only_button',
    'permission_allow_always_button',
    'permission_allow_button',
    'permission_allow_selected_button',
    'permission_allow_one_time_button',
    'permission_deny_button',
    'permission_deny_and_dont_ask_again_button',
  ];
  for (const identifier of knownGrantIds) {
    const candidate = findAndroidAlertCandidate([
      node(0, 'android.widget.FrameLayout', {
        bundleId: 'com.google.android.permissioncontroller',
      }),
      text(1, 'Allow Probe?', 'com.android.permissioncontroller:id/permission_message'),
      button(2, 'Grant one', identifier, { x: 32, y: 1420 }, true),
      button(3, 'Grant two', 'permission_allow_one_time_button', { x: 32, y: 1490 }, true),
      button(4, 'Deny', 'permission_deny_button', { x: 32, y: 1560 }, true),
    ]);
    const chosen = chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept');
    if (identifier === 'permission_allow_one_time_button') {
      // The one declared tie: the last-ranked accept id named at two points, which refuses.
      assert.equal(chosen, null, `grant id ${identifier} resolved against its own tie`);
      continue;
    }
    assert.notEqual(chosen, null, `grant id ${identifier} carries no declared rank`);
    if (identifier.includes('deny')) {
      // The same boundary on the dismiss scale: pair each deny id with the other declared deny
      // id under localized labels — the plain deny slot must win, which only a rank can do.
      const other =
        identifier === 'permission_deny_button'
          ? 'permission_deny_and_dont_ask_again_button'
          : 'permission_deny_button';
      const dismissPair = findAndroidAlertCandidate([
        node(0, 'android.widget.FrameLayout', {
          bundleId: 'com.google.android.permissioncontroller',
        }),
        text(
          1,
          '¿Permitir que Probe acceda?',
          'com.android.permissioncontroller:id/permission_message',
        ),
        button(2, 'Permitir', 'permission_allow_button', { x: 32, y: 1420 }, true),
        button(3, 'Declinar uno', identifier, { x: 32, y: 1490 }, true),
        button(4, 'Declinar dos', other, { x: 32, y: 1560 }, true),
      ]);
      const declined = chooseAndroidAlertButton(dismissPair?.buttons ?? [], 'dismiss');
      assert.equal(
        declined?.label,
        identifier === 'permission_deny_button' ? 'Declinar uno' : 'Declinar dos',
        `deny id ${identifier} does not resolve on the declared dismiss scale`,
      );
      continue;
    }
    // Every accept id outranks the last-ranked slot on the one declared scale.
    assert.equal(chosen?.label, 'Grant one', `grant id ${identifier} ranked out of order`);
  }
});

test('the two deny ids resolve on one declared dismiss scale', () => {
  // Deny ids rank inside the same declaration: on a localized sheet that names both declines,
  // the plain deny outranks the don't-ask-again variant instead of refusing on unread labels.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.google.android.permissioncontroller',
    }),
    text(
      1,
      '¿Permitir que Probe acceda?',
      'com.android.permissioncontroller:id/permission_message',
    ),
    button(2, 'Permitir', 'permission_allow_button', { x: 32, y: 1420 }, true),
    button(3, 'Rechazar', 'permission_deny_button', { x: 32, y: 1490 }, true),
    button(
      4,
      'Rechazar y no volver a preguntar',
      'permission_deny_and_dont_ask_again_button',
      {
        x: 32,
        y: 1560,
      },
      true,
    ),
  ]);

  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss')?.label, 'Rechazar');
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
  // The undeclared grant stands beside the known deny too, so the boundary names no button for
  // either action; at the seam the refusal answers `alert_button_undecided` for accept and the
  // Back fallback for dismiss — the deny id is never pressed beside an unnameable grant.
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss'), null);
});

test('an unknown grant id standing alone refuses instead of being pressed', () => {
  // The maintainer's literal rule at its sharpest: a fork's own allow-shaped id is the sheet's
  // only button. No declaration states this grant's role or rank, so no path may press it —
  // not the role choice (its role is now undeclared, not accept), not the single-candidate
  // rule, and not the single-button fallback (the refusal is the whole sheet's, not per-role).
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', { bundleId: 'com.vendor.permissioncontroller' }),
    text(1, 'Allow Probe?', 'com.android.permissioncontroller:id/permission_message'),
    button(
      2,
      'Allow everything and sync',
      'com.vendor.permissioncontroller:id/permission_allow_everything_button',
      { x: 32, y: 1420 },
      false,
    ),
  ]);

  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept'), null);
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss'), null);
});

test('an unknown grant id cannot earn a role from an affirmative label', () => {
  // The label vocabulary is the fallback for buttons the backend declares nothing about. An
  // allow/deny-shaped grant id is not such a button: letting English copy alone classify it
  // would re-admit the accept-by-id-without-rank the declaration exists to make impossible,
  // and the single candidate would then be pressed.
  for (const label of ['Allow all', 'Open', 'Done', 'Confirm purchase', 'Keep Browsing']) {
    const candidate = findAndroidAlertCandidate([
      node(0, 'android.widget.FrameLayout', { bundleId: 'com.vendor.permissioncontroller' }),
      text(1, 'Allow Probe?', 'com.android.permissioncontroller:id/permission_message'),
      button(
        2,
        label,
        'com.vendor.permissioncontroller:id/permission_allow_fine_location_and_sync_button',
        { x: 32, y: 1420 },
        false,
      ),
    ]);

    assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept'), null);
    assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss'), null);
  }
});

test('an unknown deny-shaped grant standing alone refuses dismiss instead of being pressed', () => {
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', { bundleId: 'com.vendor.permissioncontroller' }),
    text(1, 'Allow Probe?', 'com.android.permissioncontroller:id/permission_message'),
    button(
      2,
      'Never allow',
      'com.vendor.permissioncontroller:id/permission_deny_and_block_button',
      { x: 32, y: 1420 },
      false,
    ),
  ]);

  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss'), null);
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept'), null);
});

test('an unknown grant beside a declared one refuses in either order', () => {
  // Unknown + known, known + unknown: the unknown grant stays represented — it is never dropped
  // so the declared grant could win alone, and it is never ordered by tree position. Both the
  // unknown-allow-first and the declared-allow-first sheet refuse acting entirely.
  for (const unknownFirst of [true, false]) {
    const unknown = button(
      2,
      'Allow with sync',
      'com.vendor.permissioncontroller:id/permission_allow_with_sync_button',
      { x: 32, y: 1420 },
      false,
    );
    const known = button(
      3,
      'Permitir todo',
      'permission_allow_all_button',
      { x: 32, y: 1490 },
      true,
    );
    const deny = button(4, 'No permitir', 'permission_deny_button', { x: 32, y: 1560 }, true);
    const candidate = findAndroidAlertCandidate([
      node(0, 'android.widget.FrameLayout', {
        bundleId: 'com.google.android.permissioncontroller',
      }),
      text(
        1,
        '¿Permitir que Probe acceda?',
        'com.android.permissioncontroller:id/permission_message',
      ),
      ...(unknownFirst ? [unknown, known, deny] : [known, unknown, deny]),
    ]);

    assert.equal(
      chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept'),
      null,
      `unknown-first=${unknownFirst}: accept pressed beside an undeclared grant`,
    );
    assert.equal(
      chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss'),
      null,
      `unknown-first=${unknownFirst}: dismiss pressed beside an undeclared grant`,
    );
  }
});

test('two unknown grants refuse together', () => {
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', { bundleId: 'com.vendor.permissioncontroller' }),
    text(1, 'Allow Probe?', 'com.android.permissioncontroller:id/permission_message'),
    button(
      2,
      'Allow and sync',
      'com.vendor.permissioncontroller:id/permission_allow_and_sync_button',
      { x: 32, y: 1420 },
      false,
    ),
    button(
      3,
      'Decline for now',
      'com.vendor.permissioncontroller:id/permission_deny_for_now_button',
      { x: 32, y: 1490 },
      false,
    ),
  ]);

  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept'), null);
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss'), null);
});

test('a future AOSP grant id outside the table also refuses rather than pressing alone', () => {
  // Not a vendor fork: the controller's own id home, a grant name the table has not learned
  // yet. The same typed fact covers it — undeclared is undeclared, whoever ships it.
  const candidate = findAndroidAlertCandidate([
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.google.android.permissioncontroller',
    }),
    text(1, 'Allow Probe?', 'com.android.permissioncontroller:id/permission_message'),
    button(2, 'Allow all media', 'permission_allow_all_media_button', { x: 32, y: 1420 }, true),
  ]);

  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept'), null);
  assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss'), null);
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

test('shared Apple label additions also name ordinary Android dialog actions', () => {
  for (const label of ['Open', 'Done', 'Confirm purchase']) {
    const candidate = findAndroidAlertCandidate([
      node(0, 'android.app.AlertDialog'),
      text(1, 'Leave this page?', 'android:id/alertTitle'),
      button(2, 'Keep Browsing', 'com.example:id/stay', { x: 52, y: 612 }),
      button(3, label, 'com.example:id/proceed', { x: 210, y: 612 }),
    ]);
    assert.deepEqual(
      candidate?.buttons.map(({ role }) => role),
      ['dismiss', 'accept'],
    );
    assert.equal(chooseAndroidAlertButton(candidate?.buttons ?? [], 'accept')?.label, label);
    assert.equal(
      chooseAndroidAlertButton(candidate?.buttons ?? [], 'dismiss')?.label,
      'Keep Browsing',
    );
  }
});
