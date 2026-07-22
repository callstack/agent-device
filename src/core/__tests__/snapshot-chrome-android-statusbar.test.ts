import { test } from 'vitest';
import assert from 'node:assert/strict';
import { attachRefs, type RawSnapshotNode, type SnapshotNode } from '../../kernel/snapshot.ts';
import { collectSettleChromeRefs, withoutSettleChrome } from '../snapshot-chrome.ts';
import {
  ANDROID_IME_CAPTURE_RAW_NODES,
  ANDROID_QS_SHADE_CAPTURE_RAW_NODES,
  walkInteractiveOnlyAndroidFixture,
  walkNonRawAndroidFixture,
} from '../../__tests__/test-utils/android-ui-hierarchy-fixtures.ts';
import { isAndroidSystemChromeWindowResourceId } from '../../contracts/android-system-chrome.ts';

/**
 * The `walk*AndroidFixture` helpers run a real `--raw` device capture through
 * production's own walk, so every inclusion decision below is production's
 * rather than a hand-simulation of it.
 */

function refForIdentifier(nodes: SnapshotNode[], identifier: string): string {
  const node = nodes.find((candidate) => candidate.identifier === identifier);
  assert.ok(node?.ref, `expected a node identified "${identifier}" with a ref`);
  return node.ref;
}

/** Status-bar leaves that survive the non-raw walk for this fixture; none carries a chrome id. */
const STATUS_BAR_LEAF_IDENTIFIERS = [
  'com.android.systemui:id/clock',
  'com.android.systemui:id/mobile_combo',
  'com.android.systemui:id/mobile_signal',
  'com.android.systemui:id/wifi_signal',
];

test('Android chrome container ids match complete status/nav-bar segments only', () => {
  assert.equal(
    isAndroidSystemChromeWindowResourceId(
      'com.android.systemui:id/status_bar_launch_animation_container',
    ),
    true,
  );
  assert.equal(
    isAndroidSystemChromeWindowResourceId('com.android.systemui:id/split_shade_status_bar'),
    true,
  );
  assert.equal(
    isAndroidSystemChromeWindowResourceId('com.android.systemui:id/status_barometer'),
    false,
  );
  assert.equal(isAndroidSystemChromeWindowResourceId('com.example:id/status_bar'), false);
});

test('Android non-raw capture: status-bar leaves stay chrome after the walk drops the container that identifies them (#1251)', () => {
  const walkedNodes = walkNonRawAndroidFixture(ANDROID_IME_CAPTURE_RAW_NODES);
  const nodes = attachRefs(walkedNodes);
  const chromeRefs = collectSettleChromeRefs(nodes, 'com.callstack.agentdevicelab');

  // None of the status_bar*/navigation_bar* WRAPPER identifiers survive the
  // real walk at all — confirms the walk, not this test, is doing the drop.
  for (const node of nodes) {
    const identifier = node.identifier ?? '';
    assert.equal(
      identifier.startsWith('com.android.systemui:id/status_bar') ||
        identifier.startsWith('com.android.systemui:id/navigation_bar'),
      false,
      `expected the walk to have dropped wrapper "${identifier}"`,
    );
  }

  for (const identifier of STATUS_BAR_LEAF_IDENTIFIERS) {
    assert.equal(
      chromeRefs.has(refForIdentifier(nodes, identifier)),
      true,
      `expected ${identifier} to be classified as systemui chrome`,
    );
  }

  // The whole systemui run drops together, including the anonymous Compose
  // plumbing nodes above/around the leaves that carry no identifier at all
  // (and the re-parented, now-anonymous battery leaf).
  const systemUiRefs = nodes
    .filter((node) => node.bundleId === 'com.android.systemui')
    .map((node) => node.ref);
  assert.equal(systemUiRefs.length > 0, true);
  for (const ref of systemUiRefs) {
    assert.equal(chromeRefs.has(ref), true, 'expected every systemui-owned node to be chrome');
  }

  // App fields and the IME keyboard, both real nodes from the same capture,
  // are handled exactly as before: the checkout form stays fully visible and
  // the IME keyboard is still classified as chrome in full.
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'field-name')), false);
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'field-email')), false);
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'field-phone')), false);
  const imeRefs = nodes
    .filter((node) => node.bundleId === 'com.google.android.inputmethod.latin')
    .map((node) => node.ref);
  assert.equal(imeRefs.length > 0, true);
  for (const ref of imeRefs) {
    assert.equal(chromeRefs.has(ref), true, 'expected every IME-owned node to be chrome');
  }
});

test('Android actionable systemui overlay (volume dialog) still survives the chrome filter (#1251)', () => {
  // Real volume-dialog ids grafted onto an unrelated capture (#1264 finding 2:
  // synthetic placement, real ids). Chrome must stay a status/nav-bar fact and
  // never widen to "any systemui id", which would swallow this overlay.
  const rawWithVolumeDialog: RawSnapshotNode[] = [
    ...ANDROID_IME_CAPTURE_RAW_NODES,
    {
      index: 9000,
      type: 'android.widget.FrameLayout',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/volume_dialog_container',
    },
    {
      index: 9001,
      parentIndex: 9000,
      type: 'android.widget.ImageButton',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/volume_new_ringer_active_icon_container',
      label: 'Ringer volume',
      hittable: true,
    },
  ];
  const nodes = attachRefs(walkNonRawAndroidFixture(rawWithVolumeDialog));
  const chromeRefs = collectSettleChromeRefs(nodes, 'com.callstack.agentdevicelab');

  // The container is non-hittable with a generic id, but its hittable
  // `volume_new_ringer_active_icon_container` child keeps it in the walked
  // tree (descendantHittable).
  assert.equal(
    chromeRefs.has(refForIdentifier(nodes, 'com.android.systemui:id/volume_dialog_container')),
    false,
  );
  assert.equal(
    chromeRefs.has(
      refForIdentifier(nodes, 'com.android.systemui:id/volume_new_ringer_active_icon_container'),
    ),
    false,
  );
  // The status-bar leak fix stays active in the very same tree.
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'com.android.systemui:id/clock')), true);
});

/**
 * Synthetic: the real capture (#1251) has no nav bar (gesture-nav device).
 * `home_handle` is an `android.view.View` with a generic resource id, no
 * label, and (unlike `volume_dialog_slider` above) is neither hittable nor
 * home to a hittable descendant — production's `shouldIncludeStructuralAndroidNode`
 * drops it before `collectSettleChromeRefs` ever runs, so it is simply ABSENT
 * from the walked tree, not present-and-classified-as-chrome (the reviewer's
 * exact test-validity finding on #1256: the old hand-simulation only stripped
 * `status_bar*`/`navigation_bar*` wrappers and kept `home_handle` around to
 * assert it as chrome, which the real walk never does).
 */
test('Android nav-bar leaves are recognized as chrome once their navigation_bar* marker wrapper is dropped (synthetic: the real capture has no nav bar, gesture-nav device) (#1251)', () => {
  const rawNavBarNodes: RawSnapshotNode[] = [
    { index: 0, type: 'android.widget.FrameLayout', bundleId: 'com.android.systemui' },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.widget.FrameLayout',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/navigation_bar_frame',
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'android.widget.LinearLayout',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/nav_buttons',
    },
    {
      index: 3,
      parentIndex: 2,
      type: 'android.widget.ImageView',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/back',
      label: 'Back',
    },
    {
      index: 4,
      parentIndex: 2,
      type: 'android.widget.ImageView',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/home',
      label: 'Home',
    },
    {
      index: 5,
      parentIndex: 2,
      type: 'android.widget.ImageView',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/recent_apps',
      label: 'Overview',
    },
    {
      // Unlabeled, non-hittable, generic-id `android.view.View`: the real
      // walk drops this (no meaningful text/id, no hittable descendant),
      // unlike `back`/`home`/`recent_apps` which carry a label.
      index: 6,
      parentIndex: 1,
      type: 'android.view.View',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/home_handle',
    },
  ];
  const walkedNodes = walkNonRawAndroidFixture(rawNavBarNodes);
  const nodes = attachRefs(walkedNodes);
  const chromeRefs = collectSettleChromeRefs(nodes, 'com.example.app');

  for (const identifier of [
    'com.android.systemui:id/back',
    'com.android.systemui:id/home',
    'com.android.systemui:id/recent_apps',
  ]) {
    assert.equal(chromeRefs.has(refForIdentifier(nodes, identifier)), true, identifier);
  }

  // home_handle is DROPPED by the real walk (unlabeled, non-hittable, no
  // hittable descendant, generic id) — it must be absent, not chrome-classified.
  assert.equal(
    walkedNodes.some((node) => node.identifier === 'com.android.systemui:id/home_handle'),
    false,
    'expected home_handle to be dropped by the real non-raw walk, not retained',
  );
});

/**
 * A fully expanded quick-settings shade hosts the status-bar icons and the
 * quick-settings tiles in ONE window. Chrome classification must split them the
 * same way whatever shape the capture arrives in — that is what #1318 (raw:
 * every tile condemned) and #1319 (interactive-only: tiles kept) each hit from
 * one side.
 *
 * Live-verified on emulator-5554 (Pixel 9 Pro XL API 37, deskclock): raising
 * the shade mid-`--settle` diffs `+28 -25`, closing it `+25 -28`, and the
 * shade's own status bar is absent from both while `snapshot -i` of the same
 * screen still lists it.
 */
test('Android expanded quick-settings shade: tiles survive and the status bar drops, identically in every capture shape (#1318/#1319)', () => {
  const appBundleId = 'com.google.android.deskclock';

  for (const [shape, walk] of [
    ['interactive-only (--settle, wait stable)', walkInteractiveOnlyAndroidFixture],
    ['non-raw (snapshot, replay divergence)', walkNonRawAndroidFixture],
  ] as const) {
    const nodes = attachRefs(walk(ANDROID_QS_SHADE_CAPTURE_RAW_NODES));
    const kept = withoutSettleChrome(nodes, appBundleId);
    const keptIdentifiers = new Set(kept.map((node) => node.identifier));

    // The shade's actionable content survives, so opening or closing it can
    // never read as "nothing changed".
    assert.equal(keptIdentifiers.has('com.android.systemui:id/slider'), true, shape);
    assert.equal(
      kept.some((node) => node.identifier?.startsWith('com.android.systemui:id/qs_tile_')),
      true,
      `expected the quick-settings tiles to survive chrome stripping — ${shape}`,
    );

    // ...while the status-bar subtree sharing that window still drops: clock,
    // date and wifi tick constantly and are the canonical churn settle ignores.
    const chromeRefs = collectSettleChromeRefs(nodes, appBundleId);
    for (const identifier of [
      'com.android.systemui:id/split_shade_status_bar',
      'com.android.systemui:id/clock',
      'com.android.systemui:id/wifi_signal',
    ]) {
      assert.equal(
        chromeRefs.has(refForIdentifier(nodes, identifier)),
        true,
        `${identifier} ${shape}`,
      );
      assert.equal(keptIdentifiers.has(identifier), false, `${identifier} ${shape}`);
    }
  }
});
